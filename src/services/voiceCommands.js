import { RoomEvent } from "livekit-client";
import { sendRoomQuestion } from "./aiClient.js";

const CONTROL_TOPIC = "ciclope-room-control-v4";
const MAX_QUESTION_LENGTH = 4000;
const SILENCE_DELAY_MS = 2500;
const MAX_DATA_CHUNK_BYTES = 4500;
const MAX_SPEECH_CHARS = 180;

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

function splitForData(text, maxBytes = MAX_DATA_CHUNK_BYTES) {
  const encoder = new TextEncoder();
  const chunks = [];
  let current = "";
  let currentBytes = 0;

  for (const character of String(text)) {
    const size = encoder.encode(character).length;
    if (current && currentBytes + size > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

function cleanSpeechText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "O trecho de código está disponível no chat.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitForSpeech(text, maxChars = MAX_SPEECH_CHARS) {
  const cleaned = cleanSpeechText(text);
  if (!cleaned) return [];

  const sentences = cleaned.match(/[^.!?]+[.!?]?/g) || [cleaned];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxChars && current) {
        chunks.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current && /[.!?]$/.test(sentence.trim())) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function findPortugueseVoice(synthesis) {
  const voices = synthesis.getVoices?.() || [];
  return voices.find((voice) => /^pt-BR$/i.test(voice.lang))
    || voices.find((voice) => /^pt(-|_)/i.test(voice.lang))
    || null;
}

export function createVoiceCommands({
  room,
  roomCode,
  participantId,
  isOpen,
  open,
  close,
  notice,
  status
}) {
  let mode = "idle"; // idle | listening | answering | finishing | cancelling
  let questionParts = [];
  let disposed = false;
  let speaking = false;
  let ownsSpeech = false;
  let roomBusy = false;
  let activeOwner = null;
  let activeTurnId = null;
  let activeSpeechId = null;
  let turnVersion = 0;
  let requestAbort = null;
  let silenceTimer = null;
  let speechResolve = null;
  let turnEndPending = false;
  let commandQueue = Promise.resolve();
  const answerAssemblies = new Map();
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

  // Chame esta função a partir de um toque do usuário para preparar a voz
  // nativa do navegador, especialmente no Safari do iPhone.
  function unlockAudio() {
    const synthesis = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synthesis || !Utterance) return false;

    try {
      const silent = new Utterance(" ");
      silent.lang = "pt-BR";
      silent.volume = 0;
      silent.rate = 1;
      synthesis.speak(silent);
      return true;
    } catch (error) {
      console.warn("Não foi possível preparar a voz do navegador:", error);
      return false;
    }
  }

  function clearSilenceTimer() {
    if (silenceTimer !== null) {
      window.clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function clearLocalSpeech() {
    const synthesis = window.speechSynthesis;
    if (synthesis) {
      try { synthesis.cancel(); } catch { /* A fila já estava vazia. */ }
    }
    const resolve = speechResolve;
    speechResolve = null;
    if (resolve) resolve(false);
    speaking = false;
    ownsSpeech = false;
    activeSpeechId = null;
  }

  function resetRoomTurn(turnId) {
    if (turnId && activeTurnId && turnId !== activeTurnId) return;
    roomBusy = false;
    activeOwner = null;
    activeTurnId = null;
    activeSpeechId = null;
    speaking = false;
    ownsSpeech = false;
    turnEndPending = false;
  }

  async function finishTurn(message = "Resposta concluída. Diga ABRE para fazer outra pergunta.", notifyRoom = true) {
    const turnId = activeTurnId;
    const wasOwner = activeOwner === localIdentity;
    mode = "finishing";
    clearSilenceTimer();

    if (isOpen()) {
      await close(message);
    } else if (message) {
      notice(message);
    }

    if (notifyRoom && wasOwner && turnId && !disposed) {
      try {
        await publishControl({ type: "turn-end", turnId, owner: localIdentity });
      } catch (error) {
        console.warn("Não foi possível liberar a sala:", error);
      }
    }

    if (wasOwner || !roomBusy) resetRoomTurn(turnId);
    questionParts = [];
    requestAbort = null;
    mode = "idle";
    status(roomBusy ? "Outro participante está usando o Ciclope" : "Ouvindo o comando ABRE");
  }

  async function cancelActiveTurn(message = "Interação cancelada.", notifyRoom = true) {
    const turnId = activeTurnId;
    const wasOwner = activeOwner === localIdentity;
    const wasSpeaking = speaking;

    turnVersion += 1;
    clearSilenceTimer();
    requestAbort?.abort();
    requestAbort = null;
    mode = "cancelling";
    questionParts = [];
    clearLocalSpeech();
    answerAssemblies.clear();

    if (isOpen()) {
      await close(message);
    } else {
      notice(message);
    }

    if (notifyRoom && wasOwner && turnId && !disposed) {
      try {
        await publishControl({ type: "turn-end", turnId, owner: localIdentity, cancelled: true });
      } catch (error) {
        console.warn("Não foi possível notificar o cancelamento:", error);
      }
    } else if (notifyRoom && !wasOwner && (roomBusy || wasSpeaking) && turnId && !disposed) {
      try {
        await publishControl({ type: "turn-cancel-request", turnId, requester: localIdentity });
      } catch (error) {
        console.warn("Não foi possível solicitar o cancelamento:", error);
      }
    }

    if (wasOwner || !roomBusy) resetRoomTurn(turnId);
    mode = "idle";
    status(roomBusy ? "Outro participante está usando o Ciclope" : "Ouvindo o comando ABRE");
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
    turnEndPending = false;
    mode = "listening";
    questionParts = [];

    try {
      await publishControl({ type: "turn-start", turnId, owner: localIdentity });
      await open("comando");

      if (!isOpen()) {
        await finishTurn("Não consegui abrir o microfone. Tente novamente.");
        return;
      }

      status("Ouvindo sua pergunta");
      notice("Pode fazer sua pergunta. Quando terminar, fique em silêncio por cerca de 2,5 segundos e o Ciclope enviará automaticamente.");
    } catch (error) {
      await finishTurn(error.message || "Não foi possível iniciar a pergunta.");
    }
  }

  function speakLocally(text, turnId, speechId, ticket) {
    const synthesis = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    const chunks = splitForSpeech(text);

    if (!synthesis || !Utterance) {
      notice("A resposta está no chat, mas este navegador não oferece síntese de voz.");
      return Promise.resolve(false);
    }
    if (!chunks.length) return Promise.resolve(true);

    synthesis.cancel();
    speaking = true;
    activeSpeechId = speechId;
    status("Ciclope falando para a sala");

    return new Promise((resolve) => {
      let index = 0;
      let settled = false;
      const finish = (success) => {
        if (settled) return;
        settled = true;
        if (speechResolve === finishResolve) speechResolve = null;
        resolve(success);
      };
      const finishResolve = (success) => finish(success);
      speechResolve = finishResolve;

      const speakNext = () => {
        if (disposed || ticket !== turnVersion || activeSpeechId !== speechId) {
          finish(false);
          return;
        }
        if (index >= chunks.length) {
          finish(true);
          return;
        }

        const utterance = new Utterance(chunks[index]);
        index += 1;
        utterance.lang = "pt-BR";
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.volume = 1;
        const voice = findPortugueseVoice(synthesis);
        if (voice) utterance.voice = voice;
        utterance.onend = speakNext;
        utterance.onerror = (event) => {
          if (event.error !== "interrupted" && event.error !== "canceled") {
            console.warn("Erro na síntese de voz do navegador:", event.error);
          }
          finish(false);
        };

        try {
          synthesis.speak(utterance);
        } catch (error) {
          console.warn("Não foi possível reproduzir a resposta:", error);
          finish(false);
        }
      };

      speakNext();
    });
  }

  async function publishAnswerText(answer, turnId, speechId) {
    const chunks = splitForData(answer);
    await publishControl({
      type: "answer-start",
      turnId,
      speechId,
      owner: localIdentity,
      totalChunks: chunks.length
    });

    for (let index = 0; index < chunks.length; index += 1) {
      await publishControl({
        type: "answer-chunk",
        turnId,
        speechId,
        owner: localIdentity,
        index,
        text: chunks[index]
      });
    }

    await publishControl({ type: "answer-end", turnId, speechId, owner: localIdentity });
  }

  async function answerQuestion(question, turnId, ticket) {
    const controller = new AbortController();
    requestAbort = controller;
    let completionMessage = "Resposta concluída. Diga ABRE para fazer outra pergunta.";
    let answerWasSaved = false;

    try {
      await close("Pergunta enviada. O Ciclope está preparando a resposta.");
      if (disposed || ticket !== turnVersion) return;

      status("Ciclope pensando");
      const result = await sendRoomQuestion({
        roomCode,
        participantId,
        content: question,
        signal: controller.signal
      });
      if (disposed || ticket !== turnVersion) return;

      const answer = [...(result.messages || [])]
        .reverse()
        .find((message) => message.role === "assistant")?.content;
      if (!answer) throw new Error("A IA não retornou uma resposta de texto.");
      answerWasSaved = true;

      // Uma única resposta textual é distribuída pelo LiveKit. Cada aparelho
      // usa a voz nativa disponível localmente, sem Google TTS ou chave extra.
      const speechId = `${turnId}-speech-${makeId()}`;
      activeSpeechId = speechId;
      speaking = true;
      ownsSpeech = true;
      await publishAnswerText(answer, turnId, speechId);
      if (disposed || ticket !== turnVersion) return;

      const played = await speakLocally(answer, turnId, speechId, ticket);
      if (!played) {
        completionMessage = "A resposta está no chat. Não foi possível reproduzir a voz neste aparelho.";
      }
      if (disposed || ticket !== turnVersion) return;

      speaking = false;
      ownsSpeech = false;
      activeSpeechId = null;
    } catch (error) {
      if (ticket === turnVersion && error?.name !== "AbortError") {
        completionMessage = answerWasSaved
          ? `A resposta foi salva no chat, mas não consegui reproduzir a voz: ${error.message}`
          : `Não consegui concluir a pergunta: ${error.message}`;
      }
    } finally {
      if (!disposed && ticket === turnVersion) {
        await finishTurn(completionMessage);
      }
    }
  }

  async function playRemoteAnswer(text, turnId, speechId) {
    if (disposed || turnId !== activeTurnId) return;
    const ticket = turnVersion;
    speaking = true;
    activeSpeechId = speechId;
    const played = await speakLocally(text, turnId, speechId, ticket);
    if (disposed || turnId !== activeTurnId || activeSpeechId !== speechId) return;
    speaking = false;
    activeSpeechId = null;
    if (!played) notice("A resposta está no chat. Não foi possível reproduzir a voz neste aparelho.");
    if (turnEndPending) {
      resetRoomTurn(turnId);
      if (mode === "idle") status("Ouvindo o comando ABRE");
    } else {
      status("Aguardando o fim da resposta do Ciclope");
    }
  }

  function receiveControl(bytes, participant, kind, incomingTopic) {
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
          void (async () => {
            await cancelActiveTurn("Outra pessoa iniciou a pergunta primeiro. Sua tentativa foi cancelada.", false);
            roomBusy = true;
            activeOwner = incomingOwner;
            activeTurnId = payload.turnId || null;
            status("Outro participante está fazendo uma pergunta");
          })();
          return;
        }

        roomBusy = true;
        activeOwner = incomingOwner;
        activeTurnId = payload.turnId || null;
        turnEndPending = false;
        if (mode === "idle" && !speaking) status("Outro participante está fazendo uma pergunta");
        return;
      }

      if (payload.type === "answer-start" && incomingOwner !== localIdentity && payload.turnId === activeTurnId) {
        answerAssemblies.set(payload.speechId, {
          turnId: payload.turnId,
          totalChunks: Math.max(0, Number(payload.totalChunks) || 0),
          chunks: []
        });
        activeSpeechId = payload.speechId;
        speaking = true;
        status("Preparando a voz do Ciclope");
        return;
      }

      if (payload.type === "answer-chunk" && incomingOwner !== localIdentity && payload.turnId === activeTurnId) {
        const assembly = answerAssemblies.get(payload.speechId);
        if (assembly && Number.isInteger(payload.index) && payload.index >= 0) {
          assembly.chunks[payload.index] = String(payload.text || "");
        }
        return;
      }

      if (payload.type === "answer-end" && incomingOwner !== localIdentity && payload.turnId === activeTurnId) {
        const assembly = answerAssemblies.get(payload.speechId);
        if (!assembly) return;
        answerAssemblies.delete(payload.speechId);
        const text = assembly.chunks.slice(0, assembly.totalChunks).join("");
        if (text.trim()) void playRemoteAnswer(text, payload.turnId, payload.speechId);
        return;
      }

      if (payload.type === "turn-end" && payload.turnId === activeTurnId) {
        if (payload.cancelled) {
          clearLocalSpeech();
          answerAssemblies.clear();
          resetRoomTurn(payload.turnId);
        } else if (speaking) {
          turnEndPending = true;
        } else {
          resetRoomTurn(payload.turnId);
        }
        if (mode === "idle" && !speaking) status("Ouvindo o comando ABRE");
        return;
      }

      if (payload.type === "turn-cancel-request" && payload.turnId === activeTurnId && activeOwner === localIdentity) {
        void cancelActiveTurn("Um participante cancelou a interação.");
      }
    } catch (error) {
      console.warn("Mensagem de controle de voz inválida:", error);
    }
  }

  function participantDisconnected(participant) {
    if (participant?.identity === activeOwner) {
      clearLocalSpeech();
      resetRoomTurn(activeTurnId);
      if (mode === "idle") status("Ouvindo o comando ABRE");
    }
  }

  async function submitQuestion() {
    clearSilenceTimer();
    const question = questionParts.join(" ").replace(/\s+/g, " ").trim();
    if (!question) {
      notice("Ainda não captei sua pergunta. Continue falando ou diga CANCELAR.");
      return;
    }

    mode = "answering";
    const ticket = ++turnVersion;
    status("Silêncio detectado. Ciclope pensando");
    void answerQuestion(question.slice(0, MAX_QUESTION_LENGTH), activeTurnId, ticket);
  }

  function scheduleAutoSubmit() {
    clearSilenceTimer();
    if (mode !== "listening" || !questionParts.length) return;
    silenceTimer = window.setTimeout(() => {
      silenceTimer = null;
      if (mode === "listening" && questionParts.length) void submitQuestion();
    }, SILENCE_DELAY_MS);
  }

  function appendQuestion(fragment) {
    if (!fragment) return;
    const currentLength = questionParts.join(" ").length;
    if (currentLength + fragment.length + 1 > MAX_QUESTION_LENGTH) {
      notice(`A pergunta atingiu o limite de ${MAX_QUESTION_LENGTH} caracteres. Ela será enviada após uma pausa.`);
      return;
    }
    questionParts.push(fragment);
    status("Pergunta em andamento — aguardando você terminar");
    scheduleAutoSubmit();
  }

  async function processTranscript(raw) {
    if (disposed || mode === "cancelling" || mode === "finishing") return;
    const transcript = String(raw || "").trim();
    const command = normalize(transcript);
    if (!command) return;

    // CANCELAR é reconhecido apenas quando é a palavra isolada.
    if (command === "cancelar") {
      if (roomBusy && activeOwner && activeOwner !== localIdentity && mode === "idle") {
        await publishControl({ type: "turn-cancel-request", turnId: activeTurnId, requester: localIdentity });
        notice("Pedido para cancelar a interação enviado.");
        return;
      }
      if (mode !== "idle" || speaking || isOpen()) {
        await cancelActiveTurn("Comando CANCELAR reconhecido. Interação interrompida.");
      }
      return;
    }

    // ABRE pode chegar junto com o início da pergunta em um mesmo resultado.
    if (mode === "idle" && (command === "abre" || command.startsWith("abre "))) {
      await startListening();
      const remainder = transcript.replace(/^abre[\s,:;.!?\-]*/i, "").trim();
      if (remainder && mode === "listening") appendQuestion(remainder);
      return;
    }

    if (mode !== "listening") return;
    // Não há mais comando AGORA. Qualquer outra fala é parte da pergunta.
    appendQuestion(transcript);
  }

  room.on(RoomEvent.DataReceived, receiveControl);
  room.on(RoomEvent.ParticipantDisconnected, participantDisconnected);

  return {
    handle(raw) {
      commandQueue = commandQueue.then(() => processTranscript(raw)).catch(reportError);
      return commandQueue;
    },
    unlockAudio,
    cancel() {
      if (disposed) return Promise.resolve();
      if (mode === "idle" && !ownsSpeech && !speaking && !isOpen()) return Promise.resolve();
      return cancelActiveTurn("Comandos de voz desativados.", true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      turnVersion += 1;
      clearSilenceTimer();
      requestAbort?.abort();
      requestAbort = null;
      clearLocalSpeech();
      answerAssemblies.clear();
      room.off(RoomEvent.DataReceived, receiveControl);
      room.off(RoomEvent.ParticipantDisconnected, participantDisconnected);
    }
  };
}
