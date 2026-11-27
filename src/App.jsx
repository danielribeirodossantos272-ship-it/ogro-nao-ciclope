import React, { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";
import { Room, RoomEvent, Track, TokenSource } from "livekit-client";
import StudyChat from "./components/StudyChat.jsx";
import { createVoiceCommands } from "./services/voiceCommands";

// LiveKit Development Token Server (somente para testes)
const LIVEKIT_TOKEN_SERVER_ID = "ogronociclope-1qyyky";
const tokenSource = TokenSource.developmentTokenServer(LIVEKIT_TOKEN_SERVER_ID);


export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [currentParticipantId, setCurrentParticipantId] = useState(null);
  const [participants, setParticipants] = useState([]);

  // Estado do áudio compartilhado
  const [audioStatus, setAudioStatus] = useState("Desconectado");
  const [audioConnected, setAudioConnected] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [micPublished, setMicPublished] = useState(false);
  const [audioParticipants, setAudioParticipants] = useState(0);
  const [voiceCommandStatus, setVoiceCommandStatus] = useState("Desativado");
  const [voiceCommandSupported, setVoiceCommandSupported] = useState(true);

  const liveKitRoomRef = useRef(null);
  const audioContainerRef = useRef(null);
  const recognitionRef = useRef(null);
  const recognitionEnabledRef = useRef(false);
  const channelOpenRef = useRef(false);
  const voiceControllerRef = useRef(null);

  // ==========================================
  // SUPABASE - PARTICIPANTES
  // ==========================================
  async function loadParticipants(roomId) {
    const { data, error } = await supabase
      .from("room_participants")
      .select("id, display_name, joined_at")
      .eq("room_id", roomId)
      .order("joined_at", { ascending: true });

    if (error) {
      console.error("Erro ao carregar participantes:", error);
      setNotice("Não foi possível carregar os participantes.");
      return;
    }
    setParticipants(data || []);
  }

  useEffect(() => {
    if (!activeRoomId) return;
    loadParticipants(activeRoomId);

    const channel = supabase
      .channel(`room-${activeRoomId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_participants",
          filter: `room_id=eq.${activeRoomId}`,
        },
        () => loadParticipants(activeRoomId)
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") loadParticipants(activeRoomId);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeRoomId]);

  function generateRoomCode() {
    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 8; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
  }

  // ==========================================
  // CRIAR SALA
  // ==========================================
  async function createRoom() {
    const name = displayName.trim();
    if (!name) {
      setNotice("Informe seu nome antes de criar uma sala.");
      return;
    }

    setLoading(true);
    setNotice("Criando sua sala...");
    try {
      const { data: room, error: roomError } = await supabase
        .from("rooms")
        .insert({ code: generateRoomCode(), host_name: name })
        .select("id, code")
        .single();
      if (roomError) throw roomError;

      const { data: participant, error: participantError } = await supabase
        .from("room_participants")
        .insert({ room_id: room.id, display_name: name })
        .select("id")
        .single();
      if (participantError) throw participantError;

      setCurrentParticipantId(participant.id);
      setRoomCode(room.code);
      setParticipants([]);
      setActiveRoomId(room.id);
      setNotice(`Sala criada! Código: ${room.code}`);
    } catch (error) {
      console.error("Erro ao criar sala:", error);
      setNotice(error.message || "Não foi possível criar a sala.");
    } finally {
      setLoading(false);
    }
  }

  // ==========================================
  // ENTRAR NA SALA
  // ==========================================
  async function joinRoom() {
    const name = displayName.trim();
    const code = roomCode.trim().toUpperCase();
    if (!name || !code) {
      setNotice("Informe seu nome e o código da sala.");
      return;
    }

    setLoading(true);
    setNotice("Procurando sala...");
    try {
      const { data: room, error: roomError } = await supabase
        .from("rooms")
        .select("id, code")
        .eq("code", code)
        .maybeSingle();
      if (roomError) throw roomError;
      if (!room) {
        setNotice("Sala não encontrada. Confira o código.");
        return;
      }

      const { data: participant, error: participantError } = await supabase
        .from("room_participants")
        .insert({ room_id: room.id, display_name: name })
        .select("id")
        .single();
      if (participantError) throw participantError;

      setCurrentParticipantId(participant.id);
      setRoomCode(room.code);
      setParticipants([]);
      setActiveRoomId(room.id);
      setNotice(`Você entrou na sala ${room.code}!`);
    } catch (error) {
      console.error("Erro ao entrar na sala:", error);
      setNotice(error.message || "Não foi possível entrar na sala.");
    } finally {
      setLoading(false);
    }
  }

  function updateAudioParticipants(liveRoom) {
    setAudioParticipants(liveRoom.remoteParticipants.size + 1);
  }

  // ==========================================
  // ABRIR / FECHAR CANAL DE VOZ
  // ==========================================
  async function openVoiceChannel(source = "comando") {
    const liveRoom = liveKitRoomRef.current;
    if (!liveRoom) {
      setNotice("Conecte o áudio da sala antes de falar ABRE.");
      return;
    }
    if (channelOpenRef.current) return;

    try {
      const publication = await liveRoom.localParticipant.setMicrophoneEnabled(true);
      const micTrack = liveRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (!publication && !micTrack) {
        throw new Error("O LiveKit não confirmou a publicação do microfone.");
      }

      channelOpenRef.current = true;
      setMicEnabled(true);
      setMicPublished(true);
      setNotice(
        source === "comando"
          ? "Canal aberto! Os participantes já podem ouvir você."
          : "Canal de voz aberto. Os participantes já podem ouvir você."
      );
    } catch (error) {
      console.error("Erro ao abrir canal de voz:", error);
      setNotice("Não foi possível abrir o canal: " + error.message);
    }
  }

  async function closeVoiceChannel(message = "Canal de voz fechado.") {
    const liveRoom = liveKitRoomRef.current;
    channelOpenRef.current = false;
    setMicEnabled(false);
    setMicPublished(false);

    if (liveRoom) {
      try {
        await liveRoom.localParticipant.setMicrophoneEnabled(false);
      } catch (error) {
        console.error("Erro ao fechar canal:", error);
      }
    }
    setNotice(message);
  }

  // ==========================================
  // COMANDOS DE VOZ: ABRE / CANCELAR
  // ==========================================
  function stopVoiceCommands() {
    voiceControllerRef.current?.cancel();
    recognitionEnabledRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (error) {
        console.warn("Reconhecimento já estava parado:", error);
      }
      recognitionRef.current = null;
    }
    setVoiceCommandStatus("Desativado");
  }

  function startVoiceCommands() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setVoiceCommandSupported(false);
      setVoiceCommandStatus("Indisponível neste navegador");
      setNotice(
        'Este navegador não oferece reconhecimento de voz. Use o botão "Abrir canal de voz" como alternativa.'
      );
      return;
    }

    if (recognitionEnabledRef.current) {
      setNotice("O reconhecimento de comandos já está ativo.");
      return;
    }

    try {
      voiceControllerRef.current?.unlockAudio();
      const recognition = new SpeechRecognition();
      recognition.lang = "pt-BR";
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognitionRef.current = recognition;
      recognitionEnabledRef.current = true;
      setVoiceCommandSupported(true);
      setVoiceCommandStatus("Ouvindo o comando ABRE");
      setNotice('Comandos ativos: diga ABRE, faça sua pergunta e pare de falar por cerca de 2,5 segundos para enviar. Diga CANCELAR para interromper.');

      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (!event.results[i].isFinal) continue;
          voiceControllerRef.current?.handle(event.results[i][0].transcript);
        }
      };

      recognition.onerror = (event) => {
        console.error("Erro no reconhecimento de voz:", event.error);
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          recognitionEnabledRef.current = false;
          setVoiceCommandStatus("Permissão de reconhecimento negada");
          setNotice("Permita o reconhecimento de voz nas configurações do navegador.");
        } else if (event.error !== "no-speech" && event.error !== "aborted") {
          setNotice("O reconhecimento de voz apresentou um erro: " + event.error);
        }
      };

      recognition.onend = () => {
        if (recognitionEnabledRef.current) {
          // O Safari pode encerrar uma sessão após alguns segundos; tenta reiniciar.
          window.setTimeout(() => {
            if (!recognitionEnabledRef.current) return;
            try {
              recognition.start();
            } catch (error) {
              console.warn("Não foi possível reiniciar reconhecimento:", error);
            }
          }, 350);
        } else {
          setVoiceCommandStatus("Desativado");
        }
      };

      recognition.start();
    } catch (error) {
      console.error("Não foi possível iniciar reconhecimento:", error);
      recognitionEnabledRef.current = false;
      setVoiceCommandStatus("Falha ao iniciar");
      setNotice("Não foi possível iniciar os comandos de voz: " + error.message);
    }
  }

  // ==========================================
  // LIVEKIT - CONECTAR (MICROFONE INICIA FECHADO)
  // ==========================================
  async function connectAudio() {
    if (!activeRoomId || !roomCode) {
      setNotice("Entre em uma sala antes de conectar o áudio.");
      return;
    }
    if (liveKitRoomRef.current) {
      setNotice("Você já está conectado ao áudio.");
      return;
    }

    setAudioLoading(true);
    setAudioStatus("Conectando...");
    setNotice("Conectando ao servidor de áudio...");

    const liveRoom = new Room();
    try {
      liveRoom.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        console.log("Faixa de áudio recebida de:", participant.identity);

        const audioElement = track.attach();
        audioElement.autoplay = true;
        audioElement.playsInline = true;
        audioElement.muted = false;
        audioElement.volume = 1;
        audioElement.setAttribute("playsinline", "true");
        audioContainerRef.current?.appendChild(audioElement);

        try {
          await audioElement.play();
        } catch (error) {
          console.warn("Autoplay bloqueado:", error);
          setNotice('Áudio recebido. Toque em "Ativar áudio e voz do Ciclope".');
        }
        updateAudioParticipants(liveRoom);
      });

      liveRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => element.remove());
      });
      liveRoom.on(RoomEvent.ParticipantConnected, () => updateAudioParticipants(liveRoom));
      liveRoom.on(RoomEvent.ParticipantDisconnected, () => updateAudioParticipants(liveRoom));
      liveRoom.on(RoomEvent.Disconnected, () => {
        voiceControllerRef.current?.dispose();
        voiceControllerRef.current = null;
        recognitionEnabledRef.current = false;
        try { recognitionRef.current?.stop(); } catch { /* Reconhecimento já encerrado. */ }
        recognitionRef.current = null;
        setVoiceCommandStatus("Desativado");
        if (liveKitRoomRef.current === liveRoom) liveKitRoomRef.current = null;
        channelOpenRef.current = false;
        setAudioConnected(false);
        setAudioStatus("Desconectado");
        setMicEnabled(false);
        setMicPublished(false);
        setAudioParticipants(0);
        if (audioContainerRef.current) audioContainerRef.current.replaceChildren();
      });

      const liveKitRoomName = `ogro-${roomCode.toUpperCase()}`;
      const { serverUrl, participantToken } = await tokenSource.fetch({ roomName: liveKitRoomName });
      if (!serverUrl || !participantToken) {
        throw new Error("O servidor não retornou as credenciais do áudio.");
      }

      await liveRoom.connect(serverUrl, participantToken);
      liveKitRoomRef.current = liveRoom;
      voiceControllerRef.current?.dispose();
      voiceControllerRef.current = createVoiceCommands({
        room: liveRoom,
        roomCode,
        participantId: currentParticipantId,
        isOpen: () => channelOpenRef.current,
        open: openVoiceChannel,
        close: closeVoiceChannel,
        notice: setNotice,
        status: setVoiceCommandStatus,
      });
      setAudioConnected(true);
      setAudioStatus("Conectado");
      updateAudioParticipants(liveRoom);

      // Importante: NÃO habilitar o microfone aqui.
      // A transmissão só começa depois do comando ABRE ou do botão alternativo.
      await liveRoom.localParticipant.setMicrophoneEnabled(false);
      channelOpenRef.current = false;
      setMicEnabled(false);
      setMicPublished(false);
      setNotice('Áudio conectado. Ative os comandos, diga ABRE e faça sua pergunta. Após cerca de 2,5 segundos de silêncio, ela será enviada automaticamente.');
    } catch (error) {
      console.error("Erro ao conectar LiveKit:", error);
      liveRoom.disconnect();
      if (liveKitRoomRef.current === liveRoom) liveKitRoomRef.current = null;
      setAudioConnected(false);
      setAudioStatus("Erro na conexão");
      setMicEnabled(false);
      setMicPublished(false);
      setAudioParticipants(0);
      setNotice(error.message || "Não foi possível conectar ao áudio.");
    } finally {
      setAudioLoading(false);
    }
  }

  // ==========================================
  // REPRODUÇÃO DE ÁUDIO
  // ==========================================
  async function enableRemoteAudio() {
    const liveRoom = liveKitRoomRef.current;
    if (!liveRoom) {
      setNotice("Conecte-se ao áudio primeiro.");
      return;
    }
    try {
      // Prepara a síntese de voz nativa do navegador no gesto do usuário.
      const voiceAudioUnlock = voiceControllerRef.current?.unlockAudio();
      await liveRoom.startAudio();
      if (voiceAudioUnlock) {
        try {
          await voiceAudioUnlock;
        } catch (unlockError) {
          console.warn("Não foi possível preparar o áudio de voz do Ciclope:", unlockError);
        }
      }
      const elements = audioContainerRef.current?.querySelectorAll("audio") || [];
      for (const element of elements) {
        element.autoplay = true;
        element.playsInline = true;
        element.muted = false;
        element.volume = 1;
        await element.play();
      }
      setNotice("Reprodução de áudio ativada.");
    } catch (error) {
      console.error("Erro ao liberar reprodução:", error);
      setNotice("Não foi possível liberar o áudio: " + error.message);
    }
  }

  async function disconnectAudio() {
    voiceControllerRef.current?.dispose();
    voiceControllerRef.current = null;
    stopVoiceCommands();
    await closeVoiceChannel("Canal de voz fechado.");
    const liveRoom = liveKitRoomRef.current;
    liveKitRoomRef.current = null;
    if (liveRoom) liveRoom.disconnect();
    if (audioContainerRef.current) audioContainerRef.current.replaceChildren();
    channelOpenRef.current = false;
    setAudioConnected(false);
    setAudioStatus("Desconectado");
    setMicEnabled(false);
    setMicPublished(false);
    setAudioParticipants(0);
    setNotice("Você saiu da conexão de áudio.");
  }

  useEffect(() => {
    return () => {
      voiceControllerRef.current?.dispose();
      voiceControllerRef.current = null;
      recognitionEnabledRef.current = false;
      try { recognitionRef.current?.stop(); } catch (error) { /* já encerrado */ }
      liveKitRoomRef.current?.disconnect();
      liveKitRoomRef.current = null;
    };
  }, []);

  // ==========================================
  // INTERFACE
  // ==========================================
  return (
    <main className="page">
      <header className="topbar">
        <div className="brand-mark">OC</div>
        <div>
          <p className="eyebrow">ESTÚDIO DE APRENDIZADO COLETIVO</p>
          <h1>Ogro Não, <span>Ciclope</span></h1>
        </div>
        <div className="status"><i /> PRÉ-VERSÃO</div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">UMA SALA. UMA INTELIGÊNCIA. TODO MUNDO JUNTO.</p>
          <h2>Estudar em grupo,<br /><span>com uma IA compartilhada.</span></h2>
          <p className="intro">
            Entre em uma sala de voz, envie seus materiais e estude com seus colegas.
            A mesma pergunta e a mesma resposta para todos.
          </p>
        </div>
        <div className="orb-wrap" aria-hidden="true">
          <div className="orb"><div className="orb-core" /></div>
          <div className="orb-label">SALA DE ESTUDOS</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">COMECE POR AQUI</p><h3>Entrar em uma sala</h3></div>
          <div className="people">♧ <b>Participantes da sala</b></div>
        </div>

        <label>Seu nome</label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Como devemos chamar você?"
          maxLength={32}
          disabled={loading || !!activeRoomId}
        />

        <label>Código da sala</label>
        <input
          value={roomCode}
          onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
          placeholder="Ex.: CICLOPE123"
          maxLength={20}
          disabled={loading || !!activeRoomId}
        />

        {!activeRoomId && (
          <div className="actions">
            <button className="primary" onClick={joinRoom} disabled={loading}>
              {loading ? "Aguarde..." : "Entrar na sala"}<span>→</span>
            </button>
            <button className="secondary" onClick={createRoom} disabled={loading}>Criar nova sala</button>
          </div>
        )}

        {notice && <p className="notice" role="status">{notice}</p>}

        {activeRoomId && (
          <section className="participants">
            <h3>Participantes na sala</h3>
            <p>Código: {roomCode}</p>
            {participants.length === 0 ? (
              <p>Carregando participantes...</p>
            ) : (
              <ul>{participants.map((participant) => (
                <li key={participant.id}>{participant.display_name}</li>
              ))}</ul>
            )}
            <p>{participants.length} participante(s) registrado(s).</p>

            <div className="audio-panel" style={{ marginTop: 22, padding: 18, border: "1px solid #a78bfa44", borderRadius: 15, background: "#a78bfa0b" }}>
              <p className="eyebrow">LIVEKIT AUDIO</p>
              <h3>Conferência de voz</h3>
              <p style={{ fontSize: 12, color: audioConnected ? "#86efac" : "#aaa5b4", marginTop: 12 }}>● {audioStatus}</p>
              <p style={{ fontSize: 12, color: "#aaa5b4" }}>Participantes no áudio: {audioParticipants}</p>

              {audioConnected && (
                <>
                  <p style={{ fontSize: 12, color: micEnabled ? "#86efac" : "#aaa5b4" }}>
                    Canal de voz: {micEnabled ? "ABERTO" : "FECHADO"}
                  </p>
                  <p style={{ fontSize: 12, color: micPublished ? "#86efac" : "#aaa5b4" }}>
                    Publicação do microfone: {micPublished ? "Confirmada" : "Inativa (microfone fechado)"}
                  </p>
                  <p style={{ fontSize: 12, color: "#c4b5fd" }}>
                    Comandos de voz: {voiceCommandStatus}
                  </p>
                </>
              )}

              {!audioConnected ? (
                <button className="primary" style={{ width: "100%", marginTop: 12 }} onClick={connectAudio} disabled={audioLoading}>
                  {audioLoading ? "Conectando..." : "Conectar áudio"}
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 15 }}>
                  <button className="primary" onClick={enableRemoteAudio}>Ativar áudio e voz do Ciclope</button>

                  <button className="secondary" onClick={startVoiceCommands} disabled={recognitionEnabledRef.current}>
                    Ativar comandos de voz (ABRE / CANCELAR)
                  </button>

                  {micEnabled ? (
                    <button className="primary" onClick={() => voiceControllerRef.current?.cancel()}>Fechar canal de voz</button>
                  ) : (
                    <button className="secondary" onClick={() => openVoiceChannel("botão")}>Abrir canal de voz manualmente</button>
                  )}

                  <button className="secondary" onClick={stopVoiceCommands}>Desativar comandos de voz</button>
                  <button className="secondary" onClick={disconnectAudio}>Desconectar áudio</button>
                </div>
              )}

              {!voiceCommandSupported && (
                <p className="notice" style={{ marginTop: 12 }}>
                  O reconhecimento de voz não está disponível neste navegador. Use o botão manual para abrir o canal.
                </p>
              )}

              <div
                ref={audioContainerRef}
                aria-label="Áudios dos participantes"
                style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}
              />
            </div>

            <StudyChat roomCode={roomCode} participantId={currentParticipantId} participantName={displayName} />
          </section>
        )}

        <p className="privacy">
          Salas e participantes conectados ao banco de dados. Comunicação por voz integrada ao LiveKit.
        </p>
      </section>

      <section className="features">
        <article><div className="feature-icon">◉</div><h4>Voz compartilhada</h4><p>Todos acompanham a mesma conversa com a IA.</p></article>
        <article><div className="feature-icon">▤</div><h4>Materiais de estudo</h4><p>Apostilas, PDFs, imagens e exercícios em um só lugar.</p></article>
        <article><div className="feature-icon">⌘</div><h4>Comandos por voz</h4><p>ABRE inicia a pergunta, uma pausa envia automaticamente e CANCELAR interrompe.</p></article>
      </section>

      <footer>OGRO NÃO, CICLOPE <span>•</span> CONSTRUINDO JUNTOS</footer>
    </main>
  );
}
