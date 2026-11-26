

import React, { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";
import {
  Room,
  RoomEvent,
  Track,
  TokenSource,
} from "livekit-client";

// LiveKit Development Token Server
const LIVEKIT_TOKEN_SERVER_ID = "ogronociclope-1qyyky";

const tokenSource = TokenSource.developmentTokenServer(
  LIVEKIT_TOKEN_SERVER_ID
);

export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const [activeRoomId, setActiveRoomId] = useState(null);
  const [participants, setParticipants] = useState([]);

  // LiveKit states
  const [audioStatus, setAudioStatus] = useState("Desconectado");
  const [audioConnected, setAudioConnected] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [audioParticipants, setAudioParticipants] = useState(0);

  const liveKitRoomRef = useRef(null);
  const audioContainerRef = useRef(null);

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
        () => {
          loadParticipants(activeRoomId);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          loadParticipants(activeRoomId);
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeRoomId]);

  // ==========================================
  // GERAÇÃO DO CÓDIGO DA SALA
  // ==========================================

  function generateRoomCode() {
    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";

    for (let i = 0; i < 8; i++) {
      code += characters.charAt(
        Math.floor(Math.random() * characters.length)
      );
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
        .insert({
          code: generateRoomCode(),
          host_name: name,
        })
        .select("id, code")
        .single();

      if (roomError) throw roomError;

      const { error: participantError } = await supabase
        .from("room_participants")
        .insert({
          room_id: room.id,
          display_name: name,
        });

      if (participantError) throw participantError;

      setRoomCode(room.code);
      setParticipants([]);
      setActiveRoomId(room.id);

      setNotice(`Sala criada! Código: ${room.code}`);
    } catch (error) {
      console.error("Erro ao criar sala:", error);

      setNotice(
        error.message || "Não foi possível criar a sala."
      );
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

      const { error: participantError } = await supabase
        .from("room_participants")
        .insert({
          room_id: room.id,
          display_name: name,
        });

      if (participantError) throw participantError;

      setRoomCode(room.code);
      setParticipants([]);
      setActiveRoomId(room.id);

      setNotice(`Você entrou na sala ${room.code}!`);
    } catch (error) {
      console.error("Erro ao entrar na sala:", error);

      setNotice(
        error.message || "Não foi possível entrar na sala."
      );
    } finally {
      setLoading(false);
    }
  }

  // ==========================================
  // LIVEKIT - CONECTAR ÁUDIO
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
      // Eventos de áudio remoto
      liveRoom.on(
        RoomEvent.TrackSubscribed,
        (track, publication, participant) => {
          if (track.kind !== Track.Kind.Audio) return;

          const audioElement = track.attach();

          audioElement.autoplay = true;
          audioElement.playsInline = true;
          audioElement.setAttribute("playsinline", "true");

          audioContainerRef.current?.appendChild(audioElement);

          audioElement.play().catch((error) => {
            console.warn("Reprodução automática bloqueada:", error);
            setNotice(
              "Áudio conectado. Toque em Ativar áudio para ouvir os participantes."
            );
          });
        }
      );

      // Remover áudio quando participante parar de transmitir
      liveRoom.on(
        RoomEvent.TrackUnsubscribed,
        (track) => {
          track.detach().forEach((element) => element.remove());
        }
      );

      // Participante entrou no áudio
      liveRoom.on(
        RoomEvent.ParticipantConnected,
        () => {
          setAudioParticipants(
            liveRoom.remoteParticipants.size + 1
          );
        }
      );

      // Participante saiu do áudio
      liveRoom.on(
        RoomEvent.ParticipantDisconnected,
        () => {
          setAudioParticipants(
            liveRoom.remoteParticipants.size + 1
          );
        }
      );

      // Desconexão do servidor
      liveRoom.on(RoomEvent.Disconnected, () => {
        if (liveKitRoomRef.current === liveRoom) {
          liveKitRoomRef.current = null;
        }

        setAudioConnected(false);
        setAudioStatus("Desconectado");
        setMicEnabled(false);
        setAudioParticipants(0);

        if (audioContainerRef.current) {
          audioContainerRef.current.replaceChildren();
        }
      });

      // Solicitar token individual
      const liveKitRoomName = `ogro-${roomCode.toUpperCase()}`;

      const { serverUrl, participantToken } =
        await tokenSource.fetch({
          roomName: liveKitRoomName,
        });

      if (!serverUrl || !participantToken) {
        throw new Error("O servidor não retornou as credenciais.");
      }

      // Conectar ao LiveKit
      await liveRoom.connect(serverUrl, participantToken);

      liveKitRoomRef.current = liveRoom;

      setAudioConnected(true);
      setAudioStatus("Conectado");

      setAudioParticipants(
        liveRoom.remoteParticipants.size + 1
      );

      // Tentar ativar o microfone
      try {
        await liveRoom.localParticipant.setMicrophoneEnabled(true);

        setMicEnabled(true);
        setNotice("Áudio conectado! Microfone ligado.");
      } catch (micError) {
        console.error("Erro ao ativar microfone:", micError);

        setMicEnabled(false);
        setNotice(
          "Conectado ao áudio, mas não foi possível ativar o microfone. Verifique as permissões."
        );
      }
    } catch (error) {
      console.error("Erro ao conectar LiveKit:", error);

      liveRoom.disconnect();

      if (liveKitRoomRef.current === liveRoom) {
        liveKitRoomRef.current = null;
      }

      setAudioConnected(false);
      setAudioStatus("Erro na conexão");
      setMicEnabled(false);
      setAudioParticipants(0);

      setNotice(
        error.message || "Não foi possível conectar ao áudio."
      );
    } finally {
      setAudioLoading(false);
    }
  }

  // ==========================================
  // LIVEKIT - MICROFONE
  // ==========================================

  async function toggleMicrophone() {
    const liveRoom = liveKitRoomRef.current;

    if (!liveRoom) return;

    try {
      const nextState = !micEnabled;

      await liveRoom.localParticipant.setMicrophoneEnabled(
        nextState
      );

      setMicEnabled(nextState);

      setNotice(
        nextState
          ? "Microfone ligado."
          : "Microfone desligado."
      );
    } catch (error) {
      console.error("Erro no microfone:", error);

      setNotice("Não foi possível alterar o microfone.");
    }
  }

  // ==========================================
  // LIVEKIT - ATIVAR REPRODUÇÃO
  // ==========================================

  async function enableRemoteAudio() {
    if (!audioContainerRef.current) return;

    const elements =
      audioContainerRef.current.querySelectorAll("audio");

    for (const element of elements) {
      try {
        await element.play();
      } catch (error) {
        console.warn("Não foi possível reproduzir áudio:", error);
      }
    }

    setNotice("Reprodução de áudio ativada.");
  }

  // ==========================================
  // LIVEKIT - DESCONECTAR
  // ==========================================

  function disconnectAudio() {
    const liveRoom = liveKitRoomRef.current;

    if (liveRoom) {
      liveKitRoomRef.current = null;
      liveRoom.disconnect();
    }

    if (audioContainerRef.current) {
      audioContainerRef.current.replaceChildren();
    }

    setAudioConnected(false);
    setAudioStatus("Desconectado");
    setMicEnabled(false);
    setAudioParticipants(0);

    setNotice("Você saiu da conexão de áudio.");
  }

  // Limpar conexão quando o componente for desmontado
  useEffect(() => {
    return () => {
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
          <p className="eyebrow">
            ESTÚDIO DE APRENDIZADO COLETIVO
          </p>

          <h1>
            Ogro Não, <span>Ciclope</span>
          </h1>
        </div>

        <div className="status">
          <i /> PRÉ-VERSÃO
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            UMA SALA. UMA INTELIGÊNCIA. TODO MUNDO JUNTO.
          </p>

          <h2>
            Estudar em grupo,
            <br />
            <span>com uma IA compartilhada.</span>
          </h2>

          <p className="intro">
            Entre em uma sala de voz, envie seus materiais e estude
            com seus colegas. A mesma pergunta e a mesma resposta
            para todos.
          </p>
        </div>

        <div className="orb-wrap" aria-hidden="true">
          <div className="orb">
            <div className="orb-core" />
          </div>

          <div className="orb-label">SALA DE ESTUDOS</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">COMECE POR AQUI</p>
            <h3>Entrar em uma sala</h3>
          </div>

          <div className="people">
            ♧ <b>Participantes da sala</b>
          </div>
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
          onChange={(e) =>
            setRoomCode(e.target.value.toUpperCase())
          }
          placeholder="Ex.: CICLOPE123"
          maxLength={20}
          disabled={loading || !!activeRoomId}
        />

        {!activeRoomId && (
          <div className="actions">
            <button
              className="primary"
              onClick={joinRoom}
              disabled={loading}
            >
              {loading ? "Aguarde..." : "Entrar na sala"}
              <span>→</span>
            </button>

            <button
              className="secondary"
              onClick={createRoom}
              disabled={loading}
            >
              Criar nova sala
            </button>
          </div>
        )}

        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}

        {activeRoomId && (
          <section className="participants">
            <h3>Participantes na sala</h3>

            <p>Código: {roomCode}</p>

            {participants.length === 0 ? (
              <p>Carregando participantes...</p>
            ) : (
              <ul>
                {participants.map((participant) => (
                  <li key={participant.id}>
                    {participant.display_name}
                  </li>
                ))}
              </ul>
            )}

            <p>
              {participants.length} participante(s) registrado(s).
            </p>

            {/* CONTROLES DE ÁUDIO */}

            <div
              className="audio-panel"
              style={{
                marginTop: "22px",
                padding: "18px",
                border: "1px solid #a78bfa44",
                borderRadius: "15px",
                background: "#a78bfa0b",
              }}
            >
              <p className="eyebrow">LIVEKIT AUDIO</p>

              <h3>Conferência de voz</h3>

              <p
                style={{
                  fontSize: "12px",
                  color: audioConnected ? "#86efac" : "#aaa5b4",
                  marginTop: "12px",
                }}
              >
                ● {audioStatus}
              </p>

              <p
                style={{
                  fontSize: "12px",
                  color: "#aaa5b4",
                }}
              >
                Participantes no áudio: {audioParticipants}
              </p>

              {!audioConnected ? (
                <button
                  className="primary"
                  style={{ width: "100%", marginTop: "12px" }}
                  onClick={connectAudio}
                  disabled={audioLoading}
                >
                  {audioLoading
                    ? "Conectando..."
                    : "Conectar áudio"}
                </button>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    marginTop: "15px",
                  }}
                >
                  <button
                    className="primary"
                    onClick={toggleMicrophone}
                  >
                    {micEnabled
                      ? "🎙 Desligar microfone"
                      : "🎙 Ligar microfone"}
                  </button>

                  <button
                    className="secondary"
                    onClick={enableRemoteAudio}
                  >
                    Ativar áudio dos participantes
                  </button>

                  <button
                    className="secondary"
                    onClick={disconnectAudio}
                  >
                    Desconectar áudio
                  </button>
                </div>
              )}

              {/* Áudios recebidos do LiveKit */}

              <div
                ref={audioContainerRef}
                aria-label="Áudios dos participantes"
                style={{
                  position: "absolute",
                  width: "1px",
                  height: "1px",
                  overflow: "hidden",
                  clipPath: "inset(50%)",
                }}
              />
            </div>
          </section>
        )}

        <p className="privacy">
          Salas e participantes conectados ao banco de dados.
          Comunicação por voz integrada ao LiveKit.
        </p>
      </section>

      <section className="features">
        <article>
          <div className="feature-icon">◉</div>
          <h4>Voz compartilhada</h4>
          <p>
            Todos acompanham a mesma conversa com a IA.
          </p>
        </article>

        <article>
          <div className="feature-icon">▤</div>
          <h4>Materiais de estudo</h4>
          <p>
            Apostilas, PDFs, imagens e exercícios em um só lugar.
          </p>
        </article>

        <article>
          <div className="feature-icon">⌘</div>
          <h4>Comandos por voz</h4>
          <p>
            Abre, Repete, Erro e Confirmar controlam as perguntas.
          </p>
        </article>
      </section>

      <footer>
        OGRO NÃO, CICLOPE <span>•</span> CONSTRUINDO JUNTOS
      </footer>
    </main>
  );
}
