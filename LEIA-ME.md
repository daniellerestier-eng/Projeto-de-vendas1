# Servidor do Capi Coin

Servidor do jogo: contas (convidado, e-mail e Google), banco de dados SQLite, economia calculada no servidor
(à prova de trapaça), ataques e saques entre jogadores, amigos e presentes, ranking, missões, pets e
pagamentos **PIX via Mercado Pago** com QR code e crédito automático.

**Zero dependências**: só precisa do Node.js 22.13 ou mais novo. Não precisa rodar `npm install`.

## 1. Rodar no próprio celular (Termux), o jeito mais rápido de testar

```bash
pkg install nodejs-lts        # ou: pkg install nodejs
cd CapiCoinV2Server
cp .env.example .env
npm start
```

O app já vem apontando para `http://127.0.0.1:3000`, então funciona direto com o servidor rodando no
mesmo celular. Para testar com amigos você precisa publicar o servidor (passo 2).

## 2. Publicar na internet (amigos, modo online e webhook do PIX)

Qualquer lugar que rode Node 22 ou Docker serve: uma VPS (Oracle Cloud Free, Hetzner, Contabo...), Render,
Railway ou Fly.io. Tem um `Dockerfile` pronto.

- Use **HTTPS**. O Mercado Pago só envia webhook para HTTPS.
- Defina `PUBLIC_URL=https://seu-dominio.com` no `.env`.
- Guarde a pasta `data/` em disco persistente (é o banco de dados). Faça backup de `data/capicoin.db`.
- No app, na tela de login, toque em **Servidor** e digite a URL. Ou troque `DEFAULT_SERVER` em
  `app/src/main/java/com/oateam/capicoin/Data.kt` antes de gerar o APK para distribuir.

## 3. Mercado Pago (PIX)

1. No `.env`, preencha `MP_ACCESS_TOKEN=` com seu Access Token.
   - Para testes use as credenciais de **teste** (`TEST-...`). Para cobrar de verdade, as de **produção** (`APP_USR-...`).
   - **Nunca** coloque o token dentro do app Android. Ele fica só aqui no servidor.
   - Se o token já apareceu em algum lugar público (chat, print, GitHub), **gere um novo** no painel:
     Suas integrações → sua aplicação → Credenciais.
2. (Recomendado) Em *Suas integrações → Webhooks*, cadastre `https://seu-dominio.com/webhooks/mercadopago`
   com o evento **Pagamentos**, e copie a "assinatura secreta" para `MP_WEBHOOK_SECRET=`.

Como o servidor valida um pagamento:
- O app cria o pedido (`/api/pay/pix`) e mostra o QR code e o "copia e cola" devolvidos pelo Mercado Pago.
- O servidor confirma o pagamento consultando a **API do Mercado Pago**: status `approved`, valor certo e
  `external_reference` igual ao pedido. Só então credita. Cada pedido é creditado **uma única vez**, mesmo que
  o webhook e o app perguntem ao mesmo tempo.
- Ele confere pelo webhook, pelo app (a cada 3 s enquanto a tela do PIX está aberta) e por uma varredura
  automática a cada 45 s. O crédito cai mesmo que o jogador feche o app.

Preços e pacotes: edite `CATALOG` em `src/pay.js`.

Itens PIX novos da versão 5.0: `pass_premium` (R$ 14,90), `pass_plus` (R$ 29,90), `outfit_folia` (R$ 9,90),
`outfit_rainha` (R$ 19,90), `pwheel_1` (R$ 4,90) e `pwheel_6` (R$ 19,90). Rotas novas: `/api/pass`, `/api/pass/claim`,
`/api/album`, `/api/album/swap`, `/api/outfit/buy`, `/api/outfit/equip`, `/api/pwheel`, `/api/pwheel/spin`, `/api/raid/extra`.

## 4. Login com Google (opcional)

1. No [Google Cloud Console](https://console.cloud.google.com/), configure a **Tela de consentimento OAuth**.
2. Em *Credenciais → Criar credenciais → ID do cliente OAuth*, escolha o tipo **Aplicativo da Web**.
3. Em *URIs de redirecionamento autorizados*, adicione: `https://seu-dominio.com/auth/google/callback`
4. Coloque o ID e a chave secreta em `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no `.env`.

O login abre no navegador do celular e volta para o jogo pelo link `capicoin://login`. Não precisa de
SDK do Google no app. Uma conta de convidado pode ser vinculada ao Google ou a um e-mail sem perder o progresso.

## 5. Ajustes de jogo

- Economia, chances da máquina, prêmios, pets, missões e roleta: `src/game.js`
- Giros máximos e tempo de recarga: `MAX_SPINS` e `REGEN_MS` em `src/game.js`
- Jogadores-robô (para sempre haver alvos de ataque): `ensureBots(40)` em `server.js`

## 6. Testes

```bash
npm test
```

São 27 testes ponta a ponta, incluindo o fluxo de PIX com um Mercado Pago simulado.


## SEGURANÇA (v4.3)
- Sessões salvas como hash SHA-256 no banco (um vazamento do banco não entrega logins); sessões antigas migram sozinhas.
- Sessões sem uso por 60 dias expiram.
- Bloqueio de 15 minutos após 8 senhas erradas no mesmo e-mail.
- Limite de requisições por IP (usando o IP real do proxy do Railway, que não pode ser falsificado pelo cliente) e por usuário.
- Login com Google no estilo PKCE: o navegador nunca leva o token de sessão; o app troca um código de uso único
  pelo token usando um segredo que só ele tem. Vincular Google usa código de uso único (o token não vai mais na URL).
- Cabeçalhos de segurança (nosniff, frame DENY, no-referrer, HSTS).
- Recomendado: gere um novo GOOGLE_CLIENT_SECRET no Google Cloud (o antigo foi compartilhado em conversa) e
  atualize a variável no Railway.
