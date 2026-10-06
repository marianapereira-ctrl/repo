// ============================== VALIDAÇÃO E ASSINATURA ==============================

/** Confirma via Data API (getMetadata) que as dimensões e métricas do script existem na propriedade. */
function validarDimensoes() {
  const b = BANDEIRAS[0];
  const meta = AnalyticsData.Properties.getMetadata('properties/' + b.propertyId + '/metadata');
  const dims = {}, mets = {};
  meta.dimensions.forEach(d => { dims[d.apiName] = true; });
  meta.metrics.forEach(m => { mets[m.apiName] = true; });

  const usadasDim = ['deviceCategory', 'platform', 'sessionSourceMedium', 'sessionCampaignName', 'eventName', 'date', 'yearMonth', 'browserVersion', 'screenResolution'];
  const usadasMet = ['sessions', 'totalUsers', 'transactions', 'purchaseRevenue', 'eventCount', 'totalPurchasers'];
  const linhas = usadasDim.map(d => [new Date(), b.nome, 'metadata', 'dimensao ' + d, dims[d] ? 'OK' : 'NAO EXISTE', '', ''])
    .concat(usadasMet.map(m => [new Date(), b.nome, 'metadata', 'metrica ' + m, mets[m] ? 'OK' : 'NAO EXISTE', '', '']));
  substituirLinhas_(ABA_LOG, CAB_LOG, '__validacao__', [], 0, 1);
  const sh = SpreadsheetApp.getActive().getSheetByName(ABA_LOG);
  sh.getRange(sh.getLastRow() + 1, 1, linhas.length, 7).setValues(linhas);
  Logger.log(linhas.map(l => l[3] + ': ' + l[4]).join('\n'));
  SpreadsheetApp.getActive().toast('browserVersion: ' + (dims.browserVersion ? 'OK' : 'NAO EXISTE'), 'Validação', 8);
}

/**
 * Lista as combinações browserVersion x screenResolution do tráfego desktop + (direct) / (none) da Oscar web,
 * em julho e setembro, para confirmar se a assinatura de setembro é a mesma. Grava em GA_Assinatura.
 */
function descobrirAssinatura() {
  const b = BANDEIRAS[0];
  const prop = 'properties/' + b.propertyId;
  const dims = ['browserVersion', 'screenResolution', 'operatingSystem', 'country', 'sessionSourceMedium'];
  const filtro = { andGroup: { expressions: [
    { filter: { fieldName: 'deviceCategory', stringFilter: { matchType: 'EXACT', value: 'desktop' } } },
    { filter: { fieldName: 'sessionSourceMedium', inListFilter: { values: ['(direct) / (none)', '(not set)'] } } }
  ] } };
  const cab = ['Bandeira', 'Periodo', 'Versao navegador', 'Resolucao', 'Sistema', 'Pais', 'Origem/Midia', 'Sessoes', 'Transacoes', 'Receita'];
  const linhas = [];
  PERIODOS_ASSINATURA.forEach(p => {
    const resp = comRetry_(() => AnalyticsData.Properties.runReport({
      dateRanges: [{ startDate: p.ini, endDate: p.fim }],
      dimensions: dims.map(d => ({ name: d })),
      metrics: ['sessions', 'transactions', 'purchaseRevenue'].map(m => ({ name: m })),
      dimensionFilter: filtro,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: '40'
    }, prop));
    (resp.rows || []).forEach(r => linhas.push([b.nome, p.nome]
      .concat(r.dimensionValues.map(d => d.value), r.metricValues.map(m => Number(m.value)))));
  });
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('GA_Assinatura') || ss.insertSheet('GA_Assinatura');
  sh.clear();
  sh.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold');
  if (linhas.length) {
    sh.getRange(2, 1, linhas.length, 7).setNumberFormat('@');
    sh.getRange(2, 1, linhas.length, cab.length).setValues(linhas);
  }
  sh.setFrozenRows(1);
}
