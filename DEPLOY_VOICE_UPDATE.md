# Atualização de voz — Ogro Não, Ciclope

Este pacote atualiza o projeto existente. Não é necessário substituir o restante da aplicação nem alterar o banco de dados se o chat atual já funciona.

## Arquivos para enviar ao GitHub

Substitua os arquivos existentes e adicione o endpoint novo, mantendo exatamente estes caminhos:

- `src/App.jsx` — substituir
- `src/services/aiClient.js` — substituir
- `src/services/voiceCommands.js` — substituir
- `api/ai/speech.js` — novo arquivo
- `AI_SETUP.md` — substituir
- `README.md` — substituir
- `vercel.json` — novo arquivo, define até 60 segundos para a função de síntese de voz
- `.env.example` — referência das variáveis necessárias (não contém segredos)
- `TEST_REPORT.md` — verificações locais e limitações do ambiente

O restante do projeto, inclusive `api/ai/messages.js`, `src/components/StudyChat.jsx`, `src/components/StudyChat.css`, `src/supabaseClient.js`, `src/style.css`, `package.json` e a migration Supabase, foi preservado.

## Antes do teste

A conversa por texto continua usando a Groq já configurada. Para a IA falar, é necessário configurar `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` na Vercel com a credencial JSON da conta de serviço do Google Cloud. Sem essa variável, a pergunta e a resposta continuam aparecendo no chat, mas a síntese de voz retorna erro de configuração.

Veja `AI_SETUP.md` para ativar a API, criar a credencial e configurar a variável sem expor a chave no GitHub.

Depois de enviar os arquivos ao GitHub, aguarde o deploy da Vercel terminar. Só então teste com dois dispositivos.

## Comandos

- `ABRE`: abre o microfone e inicia a captura da pergunta.
- `AGORA`: finaliza e envia a pergunta à IA.
- `CANCELAR`: descarta a pergunta ou interrompe a geração/reprodução.

Diga `AGORA` isoladamente, depois de terminar a pergunta.
