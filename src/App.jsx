
import React, { useState } from "react";
import { supabase } from "./supabaseClient";

export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

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

      const { data, error } = await supabase
        .from("rooms")
        .insert({
          code,
          host_name: name,
        })
        .select("code")
        .single();

      if (error) throw error;

      setRoomCode(data.code);
      setNotice(
        `Sala criada com sucesso! Compartilhe este código: ${data.code}`
      );
    } catch (error) {
      console.error("Erro ao criar sala:", error);
      setNotice(
        "Não foi possível criar a sala. Verifique sua conexão e tente novamente."
      );
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
    setNotice("Verificando sala...");

    try {
      const { data, error } = await supabase
        .from("rooms")
        .select("id, code, host_name")
        .eq("code", code)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        setNotice("Sala não encontrada. Confira o código informado.");
        return;
      }

      setRoomCode(data.code);
      setNotice(
        `Sala ${data.code} encontrada! A conexão dos participantes será implementada na próxima etapa.`
      );
    } catch (error) {
      console.error("Erro ao consultar sala:", error);
      setNotice(
        "Não foi possível consultar a sala. Verifique sua conexão e tente novamente."
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

        <p className="privacy">
          A criação e a consulta de salas estão conectadas ao banco
          de dados. Voz compartilhada e comunicação em tempo real
          ainda serão implementadas.
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
