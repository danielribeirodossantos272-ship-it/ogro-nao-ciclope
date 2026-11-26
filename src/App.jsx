
import React, { useState } from "react";

export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [notice, setNotice] = useState("");

  function createRoom() {
    setNotice(
      "A interface inicial está pronta. A criação real de salas será conectada na próxima etapa."
    );
  }

  function joinRoom() {
    if (!displayName.trim() || !roomCode.trim()) {
      setNotice("Informe seu nome e o código da sala.");
      return;
    }

    setNotice(
      "A conexão com salas será ativada na próxima etapa. Seus dados ainda não foram enviados."
    );
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
        />

        <label>Código da sala</label>
        <input
          value={roomCode}
          onChange={(e) =>
            setRoomCode(e.target.value.toUpperCase())
          }
          placeholder="Ex.: CICLOPE123"
          maxLength={20}
        />

        <div className="actions">
          <button className="primary" onClick={joinRoom}>
            Entrar na sala <span>→</span>
          </button>

          <button className="secondary" onClick={createRoom}>
            Criar nova sala
          </button>
        </div>

        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}

        <p className="privacy">
          Esta é a primeira estrutura visual. Nenhum microfone é
          ativado e nenhum dado é transmitido nesta versão.
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
