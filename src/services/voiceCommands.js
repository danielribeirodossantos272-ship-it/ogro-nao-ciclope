import { RoomEvent } from "livekit-client";
import { getRoomMessages, sendRoomQuestion } from "./aiClient.js";

const CONTROL_TOPIC = "ciclope-room-control-v4";
const MAX_QUESTION_LENGTH = 4000;
const SILENCE_TO_SEND_MS = 2800;
const SPEECH_CHUNK_LENGTH = 420;

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function splitForSpeech(value, maxLength = SPEECH_CHUNK_LENGTH) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return [];

  const sentences = text.match(/[^.!?]+[.!?]?/g) || [text];
  const chunks = [];
  let current = "";

  for (const sentenceValue of sentences) {
    const sentence = sentenceValue.trim();
    if (!sentence) continue;

    if (sentence.length > maxLength) {
      const words = sentence.split(/\s+/);
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length > maxLength && current) {
          chunks.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function findMessage(messages, id) {
  return (messages || []).find((message) => String(message.id) === String(id));
}

export function createVoiceCommands({
  room,
  roomCode,
  participantId,
  notice,
  status,
  pauseRecognition = () => {},
  resumeRecognition = () => {}
}) {
  let mode = "idle"; // idle | listening | answering | speaking | cancelling
  let questionParts = [];
  let lastFragment = "";
  let disposed = false;
  let speaking = false;
  let roomBusy = false;
  let activeOwner = null;
  let activeTurnId = null;
  let activeSpeechId = null;
  let turnVersion = 0;
  let speechVersion = 0;
  let requestAbort = null;
  let silenceTimer = null;
  let commandQueue = Promise.resolve();
  const processedSpeechIds = new Set();
  const localIdentity = room.localParticipant.identity;

  async function publishControl(payload) {
    if (disposed || !room?.localParticipant) return;
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    await room.localParticipant.publishData(bytes, {
      reliable: true,
      topic: CONTROL_TOPIC
    });
  }

  function reportError(error) {
    if (!disposed) notice(error?.message || String(error));
  }

  function clearSilenceTimer() {
    if (silenceTimer !== null) {
      window.clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function resetRoomTurn(turnId) {
    if (turnId && activeTurnId && turnId !== activeTurnId) return;
    roomBusy = false;
    activeOwner = null;
    activeTurnId = null;
    if (!speaking) activeSpeechId = null;
  }

  function speakUtterance(text, version) {
    return new Promise((resolve, reject) => {
      const speechSynthesis = window.speechSynthesis;
      const Utterance = window.SpeechSynthesisUtterance;
      if (!speechSynthesis || !Utterance) {
        reject(new Error("A síntese de voz não está disponível neste navegador."));
        return;
      }

      const utterance = new Utterance(text);
      utterance.lang = "pt-BR";
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;

      const voices = speechSynthesis.getVoices?.() || [];
      const portugueseVoice =
        voices.find((voice) => voice.lang?.toLowerCase() === "pt-br") ||
        voices.find((voice) => voice.lang?.toLowerCase().startsWith("pt"));
      if (portugueseVoice) utterance.voice = portugueseVoice;

      let settled = false;
      const timeout = window.setTimeout(() => finish(), 45000);
      function finish(error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (error && version === speechVersion) reject(error);
        else resolve();
      }

      utterance.onend = () => finish();
      utterance.onerror = (event) => {
        if (event.error === "canceled" || event.error === "interrupted") finish();
        else finish(new Error(`Falha na reprodução de voz: ${event.error || "erro desconhecido"}.`));
      };

      if (version !== speechVersion) {
        finish();
        return;
      }
      speechSynthesis.speak(utterance);
    });
  }

  async function playQuestionAndAnswer(question, answer, turnId, speechId, ticket) {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      throw new Error("Este navegador não oferece síntese de voz. A resposta continua disponível no chat.");
    }
    if (disposed || ticket !== turnVersion) return;

    speaking = true;
    mode = "speaking";
    activeSpeechId = speechId;
    const currentSpeechVersion = ++speechVersion;
    pauseRecognition();
    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();

    try {
      status("Ciclope repetindo a pergunta");
      const questionIntro = `Você perguntou: ${question}`;
      for (const chunk of splitForSpeech(questionIntro)) {
        if (disposed || ticket !== turnVersion || currentSpeechVersion !== speechVersion) return;
        await speakUtterance(chunk, currentSpeechVersion);
      }

      status("Ciclope respondendo");
      for (const chunk of splitForSpeech(answer)) {
        if (disposed || ticket !== turnVersion || currentSpeechVersion !== speechVersion) return;
        await speakUtterance(chunk, currentSpeechVersion);
      }
    } finally {
      if (currentSpeechVersion === speechVersion) {
        speaking = false;
        activeSpeechId = null;
        if (!disposed) resumeRecognition();
        if (mode === "speaking") mode = "idle";
      }
    }
  }

  async function loadMessagesForSpeech(payload) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (disposed) return null;
      const result = await getRoomMessages(roomCode, participantId);
      const questionMessage = findMessage(result.messages, payload.questionMessageId);
      const answerMessage = findMessage(result.messages, payload.answerMessageId);
      if (questionMessage && answerMessage) {
        return {
          question: questionMessage.content,
          answer: answerMessage.content
        };
      }
      await sleep(400);
    }
    throw new Error("Não consegui carregar a pergunta e a resposta compartilhadas.");
  }

  async function finishOwnerTurn(turnId, message = "Resposta concluída. Diga ABRE para fazer outra pergunta.") {
    if (disposed) return;
    try {
      await publishControl({ type: "turn-end", turnId, owner: localIdentity });
    } catch (error) {
      console.warn("Não foi possível finalizar a interação na sala:", error);
    }
    resetRoomTurn(turnId);
    questionParts = [];
    lastFragment = "";
    requestAbort = null;
    mode = "idle";
    status("Ouvindo o comando ABRE");
    if (message) notice(message);
  }

  async function cancelActiveTurn(message = "Interação cancelada.", notifyRoom = true) {
    clearSilenceTimer();
    const turnId = activeTurnId;
    const wasOwner = activeOwner === localIdentity;
    const isRemoteTurn = roomBusy && activeOwner && activeOwner !== localIdentity;

    if (!wasOwner && isRemoteTurn && notifyRoom) {
      if (speaking) {
        speechVersion += 1;
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        speaking = false;
        activeSpeechId = null;
        mode = "idle";
        resumeRecognition();
      }
      try {
        await publishControl({ type: "turn-cancel-request", turnId, requester: localIdentity });
        notice("Pedido para cancelar a interação enviado.");
      } catch (error) {
        reportError(error);
      }
      return;
    }

    turnVersion += 1;
    speechVersion += 1;
    requestAbort?.abort();
    requestAbort = null;
    mode = "cancelling";
    questionParts = [];
    lastFragment = "";
    speaking = false;
    activeSpeechId = null;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    resumeRecognition();

    if (notifyRoom && wasOwner && turnId && !disposed) {
      try {
        await publishControl({ type: "turn-end", turnId, owner: localIdentity, cancelled: true });
      } catch (error) {
        console.warn("Não foi possível notificar o cancelamento:", error);
      }
    }

    if (wasOwner) resetRoomTurn(turnId);
    mode = "idle";
    status(roomBusy ? "Outro participante está usando o Ciclope" : "Ouvindo o comando ABRE");
    if (message) notice(message);
  }

  async function startListening() {
    if (disposed || mode !== "idle" || speaking) return;

    if (roomBusy && activeOwner !== localIdentity) {
      notice("Outra pessoa está usando o Ciclope agora. Aguarde a vez dela.");
      return;
    }

    const turnId = makeId();
    activeTurnId = turnId;
    activeOwner = localIdentity;
    roomBusy = true;
    mode = "listening";
    questionParts = [];
    lastFragment = "";
    clearSilenceTimer();

    try {
      await publishControl({ type: "turn-start", turnId, owner: localIdentity });
      status("Pode fazer sua pergunta");
      notice("ABRE reconhecido. Faça sua pergunta; ela será enviada após 2,8 segundos de silêncio. Diga CANCELAR para descartar.");
    } catch (error) {
      resetRoomTurn(turnId);
      mode = "idle";
      reportError(error);
    }
  }

  async function submitQuestion() {
    clearSilenceTimer();
    const question = questionParts.join(" ").replace(/\s+/g, " ").trim();
    if (!question) {
      mode = "listening";
      notice("Ainda não consegui reconhecer sua pergunta. Continue falando ou diga CANCELAR.");
      return;
    }

    mode = "answering";
    const ticket = ++turnVersion;
    status("Pergunta recebida. Ciclope pensando");
    void answerQuestion(question.slice(0, MAX_QUESTION_LENGTH), activeTurnId, ticket);
  }

  async function answerQuestion(question, turnId, ticket) {
    const controller = new AbortController();
    requestAbort = controller;
    let answerWasSaved = false;

    try {
      const result = await sendRoomQuestion({
        roomCode,
        participantId,
        content: question,
        signal: controller.signal
      });
      if (disposed || ticket !== turnVersion) return;

      const questionMessage = (result.messages || []).find((message) => message.role === "user");
      const answerMessage = [...(result.messages || [])].reverse().find((message) => message.role === "assistant");
      const answer = answerMessage?.content;
      if (!answer) throw new Error("A IA não retornou uma resposta de texto.");
      answerWasSaved = true;

      if (!questionMessage?.id || !answerMessage?.id) {
        throw new Error("A resposta foi salva, mas não recebi os identificadores para compartilhá-la por voz.");
      }

      const speechId = `${turnId}-speech-${makeId()}`;
      await publishControl({
        type: "answer-ready",
        turnId,
        speechId,
        owner: localIdentity,
        questionMessageId: questionMessage.id,
        answerMessageId: answerMessage.id
      });

      await playQuestionAndAnswer(question, answer, turnId, speechId, ticket);
      if (disposed || ticket !== turnVersion) return;
      await finishOwnerTurn(turnId, "Resposta concluída. Diga ABRE para fazer outra pergunta.");
    } catch (error) {
      if (disposed || ticket !== turnVersion || error?.name === "AbortError") return;
      const message = answerWasSaved
        ? `A resposta está no chat, mas não consegui reproduzir a voz: ${error.message}`
        : `Não consegui concluir a pergunta: ${error.message}`;
      await finishOwnerTurn(turnId, message);
    }
  }

  async function receiveControl(bytes, participant, kind, incomingTopic) {
    if (disposed || incomingTopic !== CONTROL_TOPIC || !participant) return;

    try {
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (!payload || typeof payload.type !== "string") return;
      const incomingOwner = payload.owner || participant.identity;

      if (payload.type === "turn-start" && incomingOwner !== localIdentity) {
        if (roomBusy && activeOwner === localIdentity && mode !== "listening") return;
        if (roomBusy && activeOwner && activeOwner !== incomingOwner) {
          if (String(activeOwner).localeCompare(String(incomingOwner)) <= 0) return;
        }
        if (mode === "listening" && activeOwner === localIdentity && activeTurnId) {
          if (String(localIdentity).localeCompare(String(incomingOwner)) < 0) return;
          await cancelActiveTurn("Outra pessoa iniciou a pergunta primeiro. Sua tentativa foi cancelada.", false);
        }
        roomBusy = true;
        activeOwner = incomingOwner;
        activeTurnId = payload.turnId || null;
        if (mode === "idle" && !speaking) status("Outro participante está fazendo uma pergunta");
        return;
      }

      if (payload.type === "answer-ready" && incomingOwner !== localIdentity) {
        if (payload.turnId !== activeTurnId || !payload.speechId) return;
        if (processedSpeechIds.has(payload.speechId)) return;
        processedSpeechIds.add(payload.speechId);
        while (processedSpeechIds.size > 30) {
          processedSpeechIds.delete(processedSpeechIds.values().next().value);
        }

        const ticket = turnVersion;
        speaking = true;
        mode = "speaking";
        activeSpeechId = payload.speechId;
        pauseRecognition();
        status("Preparando a voz do Ciclope");

        try {
          const messages = await loadMessagesForSpeech(payload);
          if (!messages || disposed || ticket !== turnVersion || activeSpeechId !== payload.speechId) return;
          await playQuestionAndAnswer(messages.question, messages.answer, payload.turnId, payload.speechId, ticket);
          if (!disposed && mode === "speaking") mode = "idle";
          if (!disposed) status(roomBusy ? "Aguardando a próxima interação" : "Ouvindo o comando ABRE");
        } catch (error) {
          if (!disposed) notice(`A resposta chegou ao chat, mas não consegui reproduzir a voz neste aparelho: ${error.message}`);
        } finally {
          if (!disposed && activeSpeechId === payload.speechId) {
            speaking = false;
            activeSpeechId = null;
            resumeRecognition();
            if (mode === "speaking") mode = "idle";
          }
        }
        return;
      }

      if (payload.type === "turn-end" && payload.turnId === activeTurnId) {
        if (payload.cancelled) {
          turnVersion += 1;
          speechVersion += 1;
          if (window.speechSynthesis) window.speechSynthesis.cancel();
          speaking = false;
          activeSpeechId = null;
          resumeRecognition();
        }
        resetRoomTurn(payload.turnId);
        if (mode === "idle" && !speaking) status("Ouvindo o comando ABRE");
        return;
      }

      if (payload.type === "turn-cancel-request" && payload.turnId === activeTurnId && activeOwner === localIdentity) {
        await cancelActiveTurn("Um participante cancelou a interação.");
      }
    } catch (error) {
      console.warn("Mensagem de controle de voz inválida:", error);
    }
  }

  function participantDisconnected(participant) {
    if (participant?.identity === activeOwner) {
      clearSilenceTimer();
      speechVersion += 1;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      speaking = false;
      resumeRecognition();
      resetRoomTurn(activeTurnId);
      if (mode !== "listening") mode = "idle";
      if (mode === "idle") status("Ouvindo o comando ABRE");
    }
  }

  room.on(RoomEvent.DataReceived, receiveControl);
  room.on(RoomEvent.ParticipantDisconnected, participantDisconnected);

  function appendQuestion(fragment) {
    const cleaned = String(fragment || "").replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned === lastFragment) return;

    const currentLength = questionParts.join(" ").length;
    if (currentLength + cleaned.length + 1 > MAX_QUESTION_LENGTH) {
      notice(`A pergunta atingiu o limite de ${MAX_QUESTION_LENGTH} caracteres. Diga CANCELAR e tente novamente com uma pergunta menor.`);
      return;
    }

    questionParts.push(cleaned);
    lastFragment = cleaned;
    clearSilenceTimer();
    silenceTimer = window.setTimeout(() => {
      if (!disposed && mode === "listening") void submitQuestion();
    }, SILENCE_TO_SEND_MS);
    status("Captando sua pergunta — envio automático após silêncio");
  }

  async function processTranscript(raw) {
    if (disposed || mode === "cancelling" || mode === "finishing") return;
    const transcript = String(raw || "").trim();
    const command = normalize(transcript);
    if (!command) return;

    if (command === "cancelar") {
      if (mode !== "idle" || speaking || roomBusy) {
        await cancelActiveTurn("Comando CANCELAR reconhecido. Interação interrompida.");
      }
      return;
    }

    if (mode === "idle" && (command === "abre" || command.startsWith("abre "))) {
      await startListening();
      const remainder = transcript.replace(/^abre[\s,:;.!?\-]*/i, "").trim();
      if (remainder && mode === "listening") appendQuestion(remainder);
      return;
    }

    if (mode !== "listening") return;
    if (command === "abre") return;
    appendQuestion(transcript);
  }

  return {
    handle(raw) {
      commandQueue = commandQueue.then(() => processTranscript(raw)).catch(reportError);
      return commandQueue;
    },
    unlockSpeech() {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        throw new Error("A voz do navegador não está disponível neste aparelho.");
      }
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
    },
    cancel() {
      if (disposed) return Promise.resolve();
      if (mode === "idle" && !speaking && !roomBusy) return Promise.resolve();
      return cancelActiveTurn("Interação cancelada.", true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearSilenceTimer();
      turnVersion += 1;
      speechVersion += 1;
      requestAbort?.abort();
      requestAbort = null;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      resumeRecognition();
      room.off(RoomEvent.DataReceived, receiveControl);
      room.off(RoomEvent.ParticipantDisconnected, participantDisconnected);
    }
  };
}
