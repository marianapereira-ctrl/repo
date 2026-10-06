// ============================== CHAMADAS À API ==============================

function executarConsultas_(b, consultas) {
  const prop = 'properties/' + b.propertyId;
  for (let i = 0; i < consultas.length; i += OPCOES.tamanhoLote) {
    const lote = consultas.slice(i, i + OPCOES.tamanhoLote);
    let resp = null;
    try {
      resp = comRetry_(() => AnalyticsData.Properties.batchRunReports({ requests: lote.map(c => c.req) }, prop));
    } catch (e) { resp = null; }   // um erro derruba o lote inteiro: refaz individualmente

    lote.forEach((c, k) => {
      if (resp && resp.reports && resp.reports[k]) { c.resp = resp.reports[k]; return; }
      try {
        c.resp = comRetry_(() => AnalyticsData.Properties.runReport(c.req, prop));
      } catch (e) {
        c.erro = e.message || String(e);
        if (c.metricasFallback) {   // ex.: 'sessions' incompatível com eventName
          try {
            const req2 = JSON.parse(JSON.stringify(c.req));
            req2.metrics = c.metricasFallback.map(m => ({ name: m }));
            c.resp = comRetry_(() => AnalyticsData.Properties.runReport(req2, prop));
            c.metricsUsadas = c.metricasFallback;
            c.usouFallback = true;
            c.erro = '';
          } catch (e2) { c.erro += ' | fallback: ' + (e2.message || e2); }
        }
      }
    });
  }
}

function comRetry_(fn) {
  let ultimo;
  for (let t = 0; t < OPCOES.tentativas; t++) {
    try { return fn(); } catch (e) {
      ultimo = e;
      const m = String(e.message || e);
      if (/quota|429|503|500|unavailable|exhausted|rate/i.test(m)) Utilities.sleep(1500 * Math.pow(2, t));
      else throw e;
    }
  }
  throw ultimo;
}

// ============================== CONVERSÃO E GRAVAÇÃO ==============================

function cabecalho_(c) {
  const cab = ['Bandeira', 'Periodo'];
  c.dims.forEach(d => cab.push(ROTULO_DIM[d] || d));
  c.metrics.forEach(m => cab.push(ROTULO_MET[m] || m));
  if (c.derivar) cab.push('CVR', 'TKM');
  cab.push('Obs');
  return cab;
}

function converterLinhas_(b, c) {
  const rows = c.resp.rows || [];
  const hdr = (c.resp.metricHeaders || []).map(h => h.name);
  return rows.map(r => {
    const dimVals = r.dimensionValues.map((d, i) => formatarDim_(c.dims[i], d.value));
    const mapa = {};
    hdr.forEach((n, i) => { mapa[n] = Number(r.metricValues[i].value); });
    const mets = c.metrics.map(m => (m in mapa ? mapa[m] : ''));
    const linha = [b.nome, c.periodo].concat(dimVals, mets);
    if (c.derivar) {
      const s = mapa.sessions, t = mapa.transactions, rec = mapa.purchaseRevenue;
      linha.push(s > 0 ? t / s : '', t > 0 ? rec / t : '');
    }
    linha.push(obs_(b, c, dimVals));
    return linha;
  });
}

function formatarDim_(nome, v) {
  if (nome === 'date' && v.length === 8) return v.substring(0, 4) + '-' + v.substring(4, 6) + '-' + v.substring(6, 8);
  return v;
}

function obs_(b, c, dimVals) {
  if (!b.avisoCompraDuplicada) return '';
  const msg = 'Compra duplicada no app desde 25/09: usar faturado';
  if (c.aba === 'GA_Diario') return dimVals[0] >= OPCOES.inicioDuplicacaoApp ? msg : '';
  if (c.aba === 'GA_Mensal_Canal' || c.aba === 'GA_Mensal_Funil') return dimVals[0] >= '202609' ? msg : '';
  return c.fim >= OPCOES.inicioDuplicacaoApp ? msg : '';
}

/** Remove as linhas da bandeira (coluna A, ou colunaChave) e acrescenta as novas. */
function substituirLinhas_(nomeAba, cab, bandeira, novas, nTexto, colunaChave) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(nomeAba) || ss.insertSheet(nomeAba);
  const k = colunaChave || 0;
  const n = cab.length;
  let manter = [];
  if (sh.getLastRow() > 1 && sh.getLastColumn() > 0) {
    manter = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
      .filter(r => r[k] !== bandeira && r[k] !== '');
  }
  const todas = manter.concat(novas).map(r => {
    const x = r.slice(0, n);
    while (x.length < n) x.push('');
    return x;
  });
  sh.clear();
  if (nTexto) sh.getRange(1, 1, Math.max(todas.length + 1, 2), nTexto).setNumberFormat('@');
  sh.getRange(1, 1, 1, n).setValues([cab]).setFontWeight('bold');
  if (todas.length) sh.getRange(2, 1, todas.length, n).setValues(todas);
  sh.setFrozenRows(1);
}

