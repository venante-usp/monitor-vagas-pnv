/**
 * Disparado imediatamente depois de `wrangler deploy` no Workers Builds.
 * Não há botão nem endpoint público de atualização: esta chamada usa um
 * segredo que só existe no ambiente de build e no Worker.
 */
const url = process.env.DEPLOY_SYNC_URL;
const token = process.env.DEPLOY_SYNC_TOKEN;

if (!url || !token) {
  console.error('Faltam DEPLOY_SYNC_URL ou DEPLOY_SYNC_TOKEN nas variáveis do build.');
  process.exit(1);
}

const destino = new URL(url);
if (destino.protocol !== 'https:') {
  console.error('DEPLOY_SYNC_URL precisa usar HTTPS.');
  process.exit(1);
}

const resposta = await fetch(destino, {
  method: 'POST',
  headers: { 'x-deploy-sync-token': token }
});

const corpo = await resposta.text();
if (!resposta.ok) {
  console.error(`A sincronização pós-deploy respondeu HTTP ${resposta.status}: ${corpo.slice(0, 500)}`);
  process.exit(1);
}

console.log('Sincronização pós-deploy iniciada:', corpo);
