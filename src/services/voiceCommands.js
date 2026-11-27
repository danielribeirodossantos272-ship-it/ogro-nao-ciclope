import { RoomEvent } from "livekit-client";
import { sendRoomQuestion, synthesizeRoomSpeech } from "./aiClient.js";

const CONTROL_TOPIC = "ciclope-room-control-v3";
const MAX_QUESTION_LENGTH = 4000;

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

function decodeBase64(value) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
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
  let audioContext = null;
  let speechDestination = null;
  let speechTrack = null;
  let speechSources = [];
  let commandQueue = Promise.resolve();

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

  async function unlockAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("Este navegador não oferece suporte ao áudio compartilhado do Ciclope.");
    }

    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextClass();
    }
    if (audioContext.state !== "running") {
      await audioContext.resume();
    }
  }

  async function stopLocalSpeech(notifyRoom = true) {
    const previousSpeechId = activeSpeechId;
    const previousTurnId = activeTurnId;
    const trackToRemove = speechTrack;
    const destinationToRemove = speechDestination;

    speechSources.forEach((source) => {
      try { source.stop(); } catch { /* A fonte já terminou. */ }
    });
    speechSources = [];
    speechTrack = null;
    speechDestination = null;
    ownsSpeech = false;
    speaking = false;
    activeSpeechId = null;

    if (trackToRemove) {
      try {
        await room.localParticipant.unpublishTrack(trackToRemove);
      } catch (error) {
        console.warn("Não foi possível remover a faixa de voz do Ciclope:", error);
      }
      try { trackToRemove.stop(); } catch { /* A faixa já foi encerrada. */ }
    }

    if (destinationToRemove) {
      destinationToRemove.stream.getTracks().forEach((track) => {
        try { track.stop(); } catch { /* A faixa já foi encerrada. */ }
      });
    }

    if (notifyRoom && previousSpeechId && !disposed) {
      try {
        await publishControl({
          type: "speech-end",
          turnId: previousTurnId,
          speechId: previousSpeechId,
          owner: localIdentity
        });
      } catch (error) {
        console.warn("Não foi possível notificar o fim da fala:", error);
      }
    }
  }

  function resetRoomTurn(turnId) {
    if (turnId && activeTurnId && turnId !== activeTurnId) return;
    roomBusy = false;
    activeOwner = null;
    activeTurnId = null;
    activeSpeechId = null;
    speaking = false;
  }

  async function finishTurn(message = "Resposta concluída. Diga ABRE para fazer outra pergunta.", notifyRoom = true) {
    const turnId = activeTurnId;
    const wasOwner = activeOwner === localIdentity;

    mode = "finishing";
    if (ownsSpeech || speechTrack) {
      await stopLocalSpeech(notifyRoom);
    }

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
    requestAbort?.abort();
    requestAbort = null;
    mode = "cancelling";
    questionParts = [];

    if (ownsSpeech || speechTrack) {
      await stopLocalSpeech(notifyRoom);
    }

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
    mode = "listening";
    questionParts = [];

    try {
      await publishControl({ type: "turn-start", turnId, owner: localIdentity });
      await open("comando");

      if (!isOpen()) {
        await finishTurn("Não consegui abrir o microfone. Tente novamente.");
        return;
      }

      status("Aguardando sua pergunta e o comando AGORA");
      notice('Pode fazer sua pergunta. Quando terminar, diga apenas "AGORA".');
    } catch (error) {
      await finishTurn(error.message || "Não foi possível iniciar a pergunta.");
    }
  }

  async function playSharedSpeech(audioChunks, turnId, ticket) {
    if (!Array.isArray(audioChunks) || audioChunks.length === 0) {
      throw new Error("O servidor não retornou o áudio da resposta.");
    }

    await unlockAudio();
    const buffers = [];
    for (const chunk of audioChunks) {
      buffers.push(await audioContext.decodeAudioData(decodeBase64(chunk)));
    }

    if (disposed || ticket !== turnVersion) return;

    const destination = audioContext.createMediaStreamDestination();
    const outgoingTrack = destination.stream.getAudioTracks()[0];
    const speechId = `${turnId}-speech-${makeId()}`;

    speechDestination = destination;
    speechTrack = outgoingTrack;
    activeSpeechId = speechId;
    ownsSpeech = true;
    speaking = true;

    await publishControl({ type: "speech-start", turnId, speechId, owner: localIdentity });
    if (disposed || ticket !== turnVersion) {
      await stopLocalSpeech(false);
      return;
    }

    // O áudio é sintetizado uma única vez no servidor e publicado como uma
    // MediaStreamTrack LiveKit. Os demais participantes recebem a mesma voz.
    await room.localParticipant.publishTrack(outgoingTrack, { name: "ciclope-tts" });
    if (disposed || ticket !== turnVersion) {
      try { await room.localParticipant.unpublishTrack(outgoingTrack); } catch { /* Pode já ter sido removida. */ }
      try { outgoingTrack.stop(); } catch { /* A faixa já foi encerrada. */ }
      if (speechTrack === outgoingTrack) await stopLocalSpeech(false);
      return;
    }

    status("Ciclope falando para a sala");
    notice("O Ciclope está respondendo por voz e texto para todos na sala.");

    let startAt = audioContext.currentTime + 0.35;
    const sources = [];
    const playbackFinished = new Promise((resolve) => {
      buffers.forEach((buffer, index) => {
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        // O publicador também escuta localmente; os outros recebem a faixa LiveKit.
        source.connect(audioContext.destination);
        if (index === buffers.length - 1) source.onended = resolve;
        source.start(startAt);
        startAt += buffer.duration;
        sources.push(source);
      });
    });

    speechSources = sources;
    await playbackFinished;

    if (disposed || ticket !== turnVersion) return;
    await stopLocalSpeech(true);
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

      status("Preparando a voz do Ciclope");
      const speech = await synthesizeRoomSpeech({
        roomCode,
        participantId,
        text: answer,
        signal: controller.signal
      });
      if (disposed || ticket !== turnVersion) return;

      await playSharedSpeech(speech.audioChunks, turnId, ticket);
    } catch (error) {
      if (ticket === turnVersion && error?.name !== "AbortError") {
        completionMessage = answerWasSaved
          ? `A resposta foi salva no chat, mas não consegui gerar ou transmitir a voz: ${error.message}`
          : `Não consegui concluir a pergunta: ${error.message}`;
      }
    } finally {
      if (!disposed && ticket === turnVersion) {
        await finishTurn(completionMessage);
      }
    }
  }

  function receiveControl(bytes, participant, kind, incomingTopic) {
    if (disposed || incomingTopic !== CONTROL_TOPIC || !participant) return;

    try {
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (!payload || typeof payload.type !== "string") return;
      const incomingOwner = payload.owner || participant.identity;

      if (payload.type === "turn-start" && incomingOwner !== localIdentity) {
        // Depois que o dono já enviou a pergunta, não permita que outro início
        // substitua uma resposta que está sendo processada ou reproduzida.
        if (roomBusy && activeOwner === localIdentity && mode !== "listening") return;

        if (roomBusy && activeOwner && activeOwner !== incomingOwner) {
          // Em caso de início simultâneo, a identidade em ordem alfabética
          // menor mantém a vez; os demais clientes adotam a mesma decisão.
          if (String(activeOwner).localeCompare(String(incomingOwner)) < 0) return;
          if (String(activeOwner).localeCompare(String(incomingOwner)) === 0) return;
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
        if (mode === "idle" && !speaking) status("Outro participante está fazendo uma pergunta");
        return;
      }

      if (payload.type === "turn-end" && payload.turnId === activeTurnId) {
        resetRoomTurn(payload.turnId);
        if (mode === "idle") status("Ouvindo o comando ABRE");
        return;
      }

      if (payload.type === "speech-start" && incomingOwner !== localIdentity && payload.turnId === activeTurnId) {
        speaking = true;
        activeSpeechId = payload.speechId || null;
        status("Ciclope falando para a sala");
        return;
      }

      if (payload.type === "speech-end" && payload.turnId === activeTurnId && (!activeSpeechId || payload.speechId === activeSpeechId)) {
        speaking = false;
        activeSpeechId = null;
        if (mode === "idle") status("Ouvindo o comando ABRE");
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
      resetRoomTurn(activeTurnId);
      if (mode === "idle") status("Ouvindo o comando ABRE");
    }
  }

  room.on(RoomEvent.DataReceived, receiveControl);
  room.on(RoomEvent.ParticipantDisconnected, participantDisconnected);

  async function submitQuestion() {
    const question = questionParts.join(" ").replace(/\s+/g, " ").trim();
    if (!question) {
      notice("Ainda não captei sua pergunta. Continue falando ou diga CANCELAR.");
      return;
    }

    mode = "answering";
    const ticket = ++turnVersion;
    status("Pergunta finalizada. Ciclope pensando");
    void answerQuestion(question.slice(0, MAX_QUESTION_LENGTH), activeTurnId, ticket);
  }

  async function processTranscript(raw) {
    if (disposed || mode === "cancelling" || mode === "finishing") return;
    const transcript = String(raw || "").trim();
    const command = normalize(transcript);
    if (!command) return;

    // CANCELAR só é reconhecido como comando isolado. Assim, uma frase como
    // "como cancelar minha inscrição" continua sendo uma pergunta normal.
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

    // ABRE pode vir sozinho ou junto com a primeira frase, caso o navegador
    // devolva tudo em um único resultado do reconhecimento.
    if (mode === "idle" && (command === "abre" || command.startsWith("abre "))) {
      await startListening();
      const remainder = transcript.replace(/^abre[\s,:;.!?\-]*/i, "").trim();
      if (remainder && mode === "listening") await processTranscript(remainder);
      return;
    }

    if (command === "abre") {
      await startListening();
      return;
    }

    if (mode !== "listening") return;

    // AGORA deve ser dito como palavra final/isolada. Se o reconhecimento
    // juntar a palavra ao fim da pergunta, retiramos apenas esse sufixo.
    if (command === "agora") {
      await submitQuestion();
      return;
    }

    if (command.endsWith(" agora")) {
      const questionFragment = transcript.replace(/\s+agora\s*$/i, "").trim();
      if (questionFragment) appendQuestion(questionFragment);
      await submitQuestion();
      return;
    }

    appendQuestion(transcript);
  }

  function appendQuestion(fragment) {
    if (!fragment) return;
    const currentLength = questionParts.join(" ").length;
    if (currentLength + fragment.length + 1 > MAX_QUESTION_LENGTH) {
      notice(`A pergunta atingiu o limite de ${MAX_QUESTION_LENGTH} caracteres. Diga AGORA para enviar ou CANCELAR para descartar.`);
      return;
    }
    questionParts.push(fragment);
    status("Pergunta em andamento — diga AGORA quando terminar");
  }

  return {
    handle(raw) {
      commandQueue = commandQueue.then(() => processTranscript(raw)).catch(reportError);
      return commandQueue;
    },
    unlockAudio,
    cancel() {
      if (disposed) return Promise.resolve();
      if (mode === "idle" && !ownsSpeech && !isOpen()) return Promise.resolve();
      return cancelActiveTurn("Comandos de voz desativados.", true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      turnVersion += 1;
      requestAbort?.abort();
      requestAbort = null;
      room.off(RoomEvent.DataReceived, receiveControl);
      room.off(RoomEvent.ParticipantDisconnected, participantDisconnected);
      void stopLocalSpeech(false);
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close().catch(() => {});
      }
      audioContext = null;
    }
  };
}
