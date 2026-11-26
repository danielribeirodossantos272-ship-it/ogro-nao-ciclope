import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./style.css";

class StartupErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Falha ao renderizar o aplicativo:", error, info);

    this.setState({
      error,
      componentStack: info?.componentStack || "Não identificado"
    });
  }

  render() {
    if (this.state.error) {
      const error = this.state.error;

      const message =
        error && typeof error.message === "string" && error.message.trim()
          ? error.message
          : String(error);

      const detail = [
        `Mensagem do erro: ${message}`,
        `Tipo: ${error?.name || "Erro desconhecido"}`,
        `Componente: ${
          this.state.componentStack || "Não identificado"
        }`,
        `Rastreamento técnico: ${
          error?.stack || "Não disponível"
        }`
      ].join("\n\n");

      return (
        <main
          style={{
            maxWidth: 720,
            margin: "10vh auto",
            padding: 24,
            color: "#f4f2f7",
            fontFamily: "system-ui",
            background: "#19171f",
            border: "1px solid #a78bfa66",
            borderRadius: 16
          }}
        >
          <h1>O aplicativo encontrou um erro</h1>

          <p>
            O HTML e o JavaScript inicial carregaram, mas a interface
            falhou durante a renderização. A mensagem principal aparece abaixo.
          </p>

          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              color: "#ffdce2"
            }}
          >
            {detail}
          </pre>

          <button
            onClick={() => window.location.reload()}
            style={{
              padding: 12,
              borderRadius: 8
            }}
          >
            Recarregar
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}

try {
  const rootElement = document.getElementById("root");

  if (!rootElement) {
    throw new Error(
      'Elemento "#root" não encontrado no index.html.'
    );
  }

  createRoot(rootElement).render(
    <StartupErrorBoundary>
      <React.StrictMode>
        <App />
      </React.StrictMode>
    </StartupErrorBoundary>
  );
} catch (error) {
  console.error("Falha ao iniciar o aplicativo:", error);

  if (window.__showStartupError) {
    window.__showStartupError(
      "Falha ao iniciar o React:",
      error?.message || String(error)
    );
  } else {
    document.body.textContent =
      "Falha ao iniciar o aplicativo: " +
      (error?.message || String(error));
  }
}
