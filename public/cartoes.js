/**
 * Leitura dos cartões do monitor (sem dependências).
 *
 * Script clássico: as funções ficam globais, usadas pelo script da página e
 * pelos testes (node:vm). Recebem os registros de vaga como /api/monitor os
 * entrega: um registro por turma e tipo de vaga.
 */

// Ordem de planilha: "2027101" antes de "2027150", "PNV3100" antes de "PNV3412".
function compararCodigos(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR', { numeric: true });
}

// "seg 08:20 10:10 qua 10:00 11:40" -> ["seg 08:20–10:10", "qua 10:00–11:40"]
function encontrosDoHorario(horario) {
  const regex = /\b(seg|ter|qua|qui|sex|s[aá]b|dom)\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/gi;
  return Array.from(String(horario || '').matchAll(regex), (achado) => `${achado[1].toLowerCase()} ${achado[2]}–${achado[3]}`);
}

function formatarEncontros(horario) {
  const encontros = encontrosDoHorario(horario);
  if (encontros.length) return encontros.join(' · ');
  return String(horario || '').replace(/\s+/g, ' ').trim() || 'Horário não informado';
}

// "PNV3412 - Sistemas Oceânicos" -> "Sistemas Oceânicos". O Júpiter às vezes
// não traz o nome e a leitura grava "Disciplina PNV3412": nesse caso, vazio.
function nomeSemCodigo(nome, codigo) {
  const texto = String(nome || '').replace(/\s+/g, ' ').trim();
  const cod = String(codigo || '').trim();
  if (!texto || !cod) return texto;
  const escapado = cod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^Disciplina\\s+${escapado}$`, 'i').test(texto)) return '';
  return texto.replace(new RegExp(`^${escapado}\\s*[-–—·:]?\\s*`, 'i'), '').trim();
}

// "Inscritos" como o Júpiter mostra (o total). Sem o campo, reconstrói a
// partir de quem aguarda vaga + pendentes + matriculados.
function inscritosDoJupiter(registro) {
  const total = registro?.inscritosTotal;
  if (total !== null && total !== undefined && total !== '' && Number.isFinite(Number(total))) return Number(total);
  const numero = (valor) => Math.max(0, Number(valor) || 0);
  return numero(registro?.inscritos) + numero(registro?.pendentes) + numero(registro?.matriculados);
}

// Junta os registros de vaga de cada turma: um item por código de turma, com
// os dados da turma uma vez só e os tipos de vaga em `vagas`, na ordem recebida.
function agruparTurmas(registros) {
  const porCodigo = new Map();
  for (const registro of registros || []) {
    const codigo = String(registro?.codigo ?? '');
    if (!porCodigo.has(codigo)) porCodigo.set(codigo, []);
    porCodigo.get(codigo).push(registro);
  }

  return Array.from(porCodigo, ([codigo, vagas]) => {
    const primeiro = (campo) => {
      for (const vaga of vagas) {
        const valor = vaga?.[campo];
        if (valor !== null && valor !== undefined && String(valor).trim() !== '') return valor;
      }
      return null;
    };
    const comEncontro = vagas.find((vaga) => encontrosDoHorario(vaga?.horario).length);
    const professores = [];
    for (const vaga of vagas) {
      for (const nome of vaga?.professores || []) {
        if (!professores.includes(nome)) professores.push(nome);
      }
    }
    return {
      codigo,
      tipoTurma: primeiro('tipoTurma') || '',
      turmaTeoricaVinculada: primeiro('turmaTeoricaVinculada'),
      inicio: primeiro('inicio'),
      fim: primeiro('fim'),
      horario: comEncontro ? comEncontro.horario : (primeiro('horario') || ''),
      professores,
      vagas
    };
  }).sort((a, b) => compararCodigos(a.codigo, b.codigo));
}
