# Monitor de vagas PNV — Cloudflare Free

Projeto pronto para publicar sem custo recorrente no **Cloudflare Workers Free**.

Ele não consulta o Júpiter no navegador. O Worker faz a consulta no servidor e guarda o resultado no **Workers KV**. Assim, o monitor é atualizado mesmo com o site fechado.

## Como funciona

- **A cada 5 minutos:** atualiza apenas 3 disciplinas ofertadas, uma por vez.
- **À 00:00 de Brasília:** começa uma sincronização completa.
  - Primeiro, lê a lista atual de códigos PNV no Júpiter.
  - Depois consulta 5 disciplinas por ciclo de cinco minutos, sempre uma por vez.
  - Isso respeita o limite gratuito de consultas externas por execução.
  - Em uma lista de cerca de 58 códigos, a sincronização normalmente termina por volta de **01:00**.
- Cada disciplina tem até 3 tentativas, com pausas progressivas; em caso de HTTP 429, o Worker espera antes de tentar de novo.
- Uma falha temporária não remove a disciplina da tela: a última versão válida é preservada.
- Uma disciplina só sai do monitor quando uma página válida do Júpiter confirma que ela está sem código de turma ofertada.

## Publicação — uma única vez

### 1. Instale o Node.js e abra esta pasta no terminal

Use Node.js 20 ou superior.

```bash
npm install
npx wrangler login
```

### 2. Crie o armazenamento KV

```bash
npx wrangler kv namespace create PNV_MONITOR
```

O comando mostrará algo semelhante a:

```text
id = "abc123..."
```

Abra `wrangler.jsonc` e troque:

```json
"id": "COLE_AQUI_O_ID_DO_KV"
```

pelo ID recebido.

### 3. Publique

```bash
npm run deploy
```

O terminal exibirá uma URL como:

```text
https://monitor-vagas-pnv.seu-subdominio.workers.dev
```

Essa será a URL pública do monitor.

## Observações importantes

- Não é necessário manter computador, navegador ou aba aberta.
- A interface é servida pelo próprio Worker; não é preciso configurar Pages nem proxy CORS.
- O cron usa UTC internamente, mas o código calcula a data de Brasília (`America/Sao_Paulo`) para iniciar a consulta completa à meia-noite local.
- O plano Free possui 100 mil requisições dinâmicas por dia, 5 cron triggers por conta e até 50 subrequisições por execução. Este projeto usa apenas 1 cron e mantém cada lote abaixo desse teto.
- A Cloudflare pode mudar limites ou condições de planos no futuro.
- Deploy inicial pela Cloudflare.
