# Configuração da voz compartilhada — Ogro Não, Ciclope

## O que esta atualização faz

- A Groq continua gerando a resposta escrita.
- O endpoint server-side `/api/ai/speech` converte essa resposta em áudio pt-BR usando Google Cloud Text-to-Speech.
- O navegador que iniciou a pergunta publica a gravação como uma faixa de áudio LiveKit chamada `ciclope-tts`.
- Todos os participantes da sala recebem a mesma faixa. A síntese acontece uma única vez por resposta.
- Os únicos comandos de voz são `ABRE`, `AGORA` e `CANCELAR`.

## 1. Variáveis da Vercel

Mantenha as variáveis que já fazem o chat funcionar e confirme que estão disponíveis no ambiente Production:

- `GROQ_API_KEY` — chave já utilizada para gerar as respostas escritas.
- `SUPABASE_URL` ou `VITE_SUPABASE_URL` — URL do projeto Supabase.
- `SUPABASE_SECRET_KEY` ou `SUPABASE_SERVICE_ROLE_KEY` — chave privada do Supabase, somente no servidor.
- `VITE_SUPABASE_URL` — URL pública usada pelo navegador.
- `VITE_SUPABASE_PUBLISHABLE_KEY` — chave pública usada pelo navegador.

Adicione esta nova variável server-side:

- `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` — conteúdo completo do JSON da conta de serviço do Google Cloud.

Opcional:

- `GOOGLE_TTS_VOICE` — padrão `pt-BR-Wavenet-B` (voz masculina brasileira).
- `GROQ_MODEL` — padrão `openai/gpt-oss-20b`.

Não coloque `GROQ_API_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` ou `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` em arquivos `src/` ou em variáveis com prefixo `VITE_`. Não envie a chave JSON ao GitHub nem a outras pessoas.

## 2. Criar a credencial Google Cloud TTS

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/).
2. Crie um projeto ou selecione um projeto existente.
3. Vincule uma conta de faturamento ao projeto. O Google exige faturamento habilitado para usar a API, embora exista uma franquia mensal sem custo; confira os limites e preços atuais antes de usar.
4. Em APIs e serviços → Biblioteca, habilite **Cloud Text-to-Speech API** (`texttospeech.googleapis.com`).
5. Abra IAM e administrador → Contas de serviço e crie uma conta de serviço para o Ciclope.
6. Em Chaves, crie uma chave no formato JSON e baixe o arquivo.
7. Na Vercel, abra Settings → Environment Variables e crie `GOOGLE_TTS_SERVICE_ACCOUNT_JSON`.
8. Cole o conteúdo JSON completo como valor. Marque como Sensitive, se a opção estiver disponível.
9. Salve e faça um novo deploy.

Se o Google retornar erro de permissão `serviceusage.services.use`, conceda à conta de serviço a função **Service Usage Consumer** (`roles/serviceusage.serviceUsageConsumer`) no projeto Google Cloud. Não conceda Owner ou Editor para contornar erros de permissão.

A voz padrão é `pt-BR-Wavenet-B`, que consta na lista oficial de vozes pt-BR do Google. Você pode escolher outra voz pt-BR e defini-la em `GOOGLE_TTS_VOICE`.

**Custos:** o Google Cloud TTS tem franquias gratuitas por tipo de voz, mas exige faturamento ativado. O uso acima da franquia pode gerar cobrança. Consulte a [página oficial de preços](https://cloud.google.com/text-to-speech/pricing?hl=pt-BR) e configure alertas de orçamento no Google Cloud.

## 3. Supabase

O chat compartilhado usa a tabela `public.room_ai_messages` que já faz parte do projeto original. A migration para recriar a estrutura em outro ambiente está em:

`supabase/migrations/20261126_create_room_ai_messages.sql`

A migration não é necessária se a tabela já existe e o chat atual já funciona. O endpoint de voz não cria nem altera tabelas.

## 4. Como usar a conversa por voz

Cada participante deve:

1. Entrar na mesma sala.
2. Conectar o áudio.
3. Tocar em **Ativar áudio dos participantes** para liberar a reprodução no navegador.
4. Tocar em **Ativar comandos de voz**.

Quem for fazer a pergunta diz:

1. **ABRE** — abre o microfone e começa a registrar a pergunta.
2. Faça a pergunta normalmente. Pausas não enviam a pergunta.
3. **AGORA** — finaliza a pergunta, fecha o microfone e envia o texto à Groq.
4. O Ciclope grava a resposta no chat, gera o áudio uma vez no servidor e transmite a mesma voz a todos pelo LiveKit.
5. **CANCELAR** — descarta uma pergunta ainda não enviada ou interrompe a geração/reprodução em andamento. Outro participante também pode pedir o cancelamento.

Diga `AGORA` isoladamente, depois de terminar a pergunta. Recomenda-se usar fones de ouvido para reduzir eco e evitar que o microfone capte o som dos alto-falantes.

A sala processa uma pergunta de voz por vez. Se outra pessoa já estiver usando o Ciclope, aguarde a vez dela.

## 5. Teste após o deploy

1. Abra a mesma sala em dois dispositivos.
2. Nos dois, conecte o áudio e toque em **Ativar áudio dos participantes**.
3. Nos dois, ative os comandos de voz.
4. No primeiro dispositivo, diga `ABRE`, faça uma pergunta e diga `AGORA`.
5. Confirme que a pergunta e a resposta aparecem no chat dos dois dispositivos e que ambos ouvem a voz do Ciclope.
6. Inicie outra pergunta e diga `CANCELAR` antes de `AGORA`; a pergunta não deve ser enviada.
7. Durante uma resposta falada, diga `CANCELAR`; a reprodução deve parar para a sala.
8. Repita o teste com apenas um participante conectado.

## 6. Tempo da função Vercel

O arquivo `vercel.json` configura até 60 segundos para `/api/ai/speech`, porque a síntese pode precisar dividir uma resposta longa em várias chamadas ao Google. O limite efetivo continua sujeito ao plano e às configurações de funções da Vercel.

## 7. Endpoints

- `GET /api/ai/messages?roomCode=XXXXXXXX&participantId=UUID`: lê o histórico da sala após validar o participante.
- `POST /api/ai/messages`: recebe `roomCode`, `participantId` e `content`, chama Groq e grava pergunta e resposta na tabela compartilhada.
- `POST /api/ai/speech`: valida sala e participante, gera a voz pt-BR no servidor e devolve segmentos de áudio ao navegador que iniciou a pergunta. Esse navegador publica uma única faixa LiveKit para a sala.

A chave de serviço do Supabase, a chave da Groq e a credencial do Google ficam somente nas funções server-side da Vercel.
