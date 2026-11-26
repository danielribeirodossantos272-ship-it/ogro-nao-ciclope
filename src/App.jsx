
import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [participants, setParticipants] = useState([]);

  async function loadParticipants(roomId) {
    const { data, error } = await supabase
      .from("room_participants")
      .select("id, display_name, joined_at")
      .eq("room_id", roomId)
      .order("joined_at", { ascending: true });

    if (error) {
      console.error("Erro ao carregar participantes:", error);
      return;
    }

    setParticipants(data || []);
  }

  useEffect(() => {
    if (!activeRoomId) return;

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

  async function createRoom() {
    const name = displayName.trim();

    if (!name) {
      setNotice("Informe seu nome antes de criar uma sala.");
      return;
    }

    setLoading(true);
    setNotice("Criando sua sala...");

    try {
      const code = generateRoomCode();

      const { data: room, error: roomError } = await supabase
        .from("rooms")
        .insert({
          code,
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

      if (participantError) {
        setRoomCode(room.code);
        throw new Error(
          `A sala ${room.code} foi criada, mas não foi possível registrar sua entrada: ${participantError.message}`
        );
      }

      setRoomCode(room.code);
      setActiveRoomId(room.id);
      setNotice(`Sala criada! Código: ${room.code}`);
    } catch (error) {
      console.error("Erro ao criar sala:", error);
      setNotice(error.message || "Não foi possível criar a sala.");
    } finally {
      setLoading(false);
    }
  }

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
      setActiveRoomId(room.id);
      setNotice(`Você entrou na sala ${room.code}!`);
    } catch (error) {
      console.error("Erro ao entrar na sala:", error);
      setNotice(
        "Não foi possível entrar na sala. Verifique sua conexão e tente novamente."
      );
    } finally {
      setLoading(false);
    }
  }

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
            ♧ <b>Até 6 participantes</b>
          </div>
        </div>

        <label>Seu nome</label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Como devemos chamar você?"
          maxLength={32}
          disabled={loading}
        />

        <label>Código da sala</label>
        <input
          value={roomCode}
          onChange={(e) =>
            setRoomCode(e.target.value.toUpperCase())
          }
          placeholder="Ex.: CICLOPE123"
          maxLength={20}
          disabled={loading}
        />

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
          </section>
        )}

        <p className="privacy">
          Salas e participantes conectados ao banco de dados.
          A comunicação por voz ainda será implementada.
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
