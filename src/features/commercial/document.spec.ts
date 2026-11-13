import { DocumentData, moneyInWords, renderDocument, sanitizeBody, validCpf } from './document.render';

describe('Documento da proposta', () => {
  const data: DocumentData = {
    company: { name: 'WorkSafe', corporateName: 'WorkSafe Brasil LTDA', cnpj: '33714458000161' },
    customer: { name: 'Alfa <b>', corporateName: 'Indústria Alfa SA', cnpj: '11222333000181' },
    contactName: 'Maria & João', sellerName: null, number: 'PC-2026-0001', title: 'Pintura', description: 'Linha 1\nLinha 2',
    date: new Date('2026-11-14T12:00:00Z'), validUntil: '2026-12-14', workDays: 22, total: 20589.11,
    sections: [
      { title: 'Mão de obra', show: true, value: 18589.11, items: [
        { description: 'Alpinista N1', unit: 'prof.', quantity: 1, value: 18589.11, show: true, detail: '22 dias úteis' },
        { description: 'Item interno', unit: null, quantity: 1, value: 0, show: false },
      ] },
      { title: 'Locações', show: true, value: 2000, items: [{ description: 'Andaime', unit: 'dia', quantity: 22, value: 2000, show: true }] },
      { title: 'Seção oculta', show: false, value: 0, items: [] },
    ],
    installments: [
      { description: 'Entrada', value: 10294.56, dueRule: 'dias_apos_aceite', dueDays: 0, dueDate: null },
      { description: null, value: 10294.55, dueRule: 'data_fixa', dueDays: null, dueDate: '2027-03-10' },
    ],
  };

  it('valor por extenso', () => {
    expect(moneyInWords(20589.11)).toBe('vinte mil, quinhentos e oitenta e nove reais e onze centavos');
    expect(moneyInWords(1)).toBe('um real');
    expect(moneyInWords(100)).toBe('cem reais');
    expect(moneyInWords(1000)).toBe('mil reais');
    expect(moneyInWords(1500.5)).toBe('mil e quinhentos reais e cinquenta centavos');
    expect(moneyInWords(2000000)).toBe('dois milhões de reais');
    expect(moneyInWords(1234567.01)).toBe('um milhão, duzentos e trinta e quatro mil, quinhentos e sessenta e sete reais e um centavo');
    expect(moneyInWords(0.99)).toBe('noventa e nove centavos');
    expect(moneyInWords(101)).toBe('cento e um reais');
  });

  it('variáveis entram com escape; desconhecidas ficam visíveis', () => {
    const html = renderDocument('<p>{{cliente.nome}} — {{ contato.nome }} — {{valor.total}} ({{valor.total_extenso}}) {{nao.existe}}</p><p>{{proposta.descricao}}</p>', data, [], 'detalhado');
    expect(html).toContain('Alfa &lt;b&gt; — Maria &amp; João — R$');
    expect(html).toContain('20.589,11');
    expect(html).toContain('vinte mil, quinhentos e oitenta e nove reais e onze centavos');
    expect(html).toContain('{{nao.existe}}');
    expect(html).toContain('Linha 1<br>Linha 2');
  });

  it('tabela de itens: detalhada, por seção e global; nunca mostra o que foi marcado para ocultar', () => {
    const detailed = renderDocument('<p>{{tabela_itens}}</p>', data, [], 'detalhado');
    expect(detailed.startsWith('<table')).toBe(true); // o parágrafo vira a tabela
    expect(detailed).toContain('Alpinista N1');
    expect(detailed).toContain('22 dias úteis');
    expect(detailed).toContain('Subtotal — Locações');
    expect(detailed).not.toContain('Item interno');
    expect(detailed).not.toContain('Seção oculta');
    const bySection = renderDocument('<p>{{tabela_itens}}</p>', data, [], 'por_secao');
    expect(bySection).toContain('Mão de obra');
    expect(bySection).not.toContain('Alpinista N1');
    const global = renderDocument('<p>{{tabela_itens}}</p>', data, [], 'global');
    expect(global).toContain('Alpinista N1');
    expect(global).toContain('Valor total: R$');
    expect(global.match(/R\$/g)).toHaveLength(1);
  });

  it('pagamento, termos e assinatura', () => {
    const html = renderDocument('<p>{{condicoes_pagamento}}</p><p>{{termos}}</p><p>{{assinatura}}</p>', data, [{ id: 1, title: 'Aceite', body: '<p>Texto do aceite.</p>' }], 'detalhado');
    expect(html).toContain('no aceite desta proposta');
    expect(html).toContain('em 10/03/2027');
    expect(html).toContain('Parcela 2 de 2');
    expect(html).toContain('<h3>Aceite</h3><p>Texto do aceite.</p>');
    expect(html).toContain('WorkSafe Brasil LTDA');
    expect(html).toContain('CNPJ 11.222.333/0001-81');
  });

  it('o corpo é limpo: sem script, evento, iframe nem link javascript', () => {
    const dirty = '<p onclick="x()">Oi <script>alert(1)</script><iframe src="//x"></iframe><a href="javascript:alert(1)">a</a><a href="https://ok.com">b</a>'
      + '<img src="http://x/y.png"><img src="https://x/y.png" onerror="z()"><span style="color:#ff0000;position:fixed">c</span><strong class="ql-size-large evil">d</strong></p>';
    const html = sanitizeBody(dirty);
    expect(html).not.toMatch(/script|onclick|onerror|iframe|javascript:|position|evil|http:\/\/x/);
    expect(html).toContain('<a href="https://ok.com" target="_blank" rel="noopener noreferrer">b</a>');
    expect(html).toContain('<img src="https://x/y.png" />');
    expect(html).toContain('style="color:#ff0000"');
    expect(html).toContain('class="ql-size-large"');
  });

  it('identidade: título de seção que ficou sem conteúdo não aparece solto', () => {
    const brand = { logoUrl: null, color: '#0B5ED7', tagline: '', about: '', highlights: [], differentials: [], testimonials: [], phone: '', email: '', website: '', address: '' };
    const body = '<p>{{capa}}</p><h2>O que entendemos</h2><p>{{proposta.descricao}}</p><p>{{imagens}}</p><h2>Valores</h2><p>{{tabela_itens}}</p><h2>Por que nós</h2><p>{{sobre}}</p><p>{{depoimentos}}</p><h2>Fim</h2><p>{{contato}}</p>';
    const empty = renderDocument(body, { ...data, description: null, brand }, [], 'detalhado');
    expect(empty).not.toContain('O que entendemos');
    expect(empty).not.toContain('Por que nós');
    expect(empty).not.toContain('Fim');
    expect(empty).toContain('<h2>Valores</h2>');
    expect(empty).toContain('data-block="capa"');
    const full = renderDocument(body, { ...data, brand: { ...brand, about: 'Somos especialistas.', phone: '81999990000' } }, [], 'detalhado');
    for (const title of ['O que entendemos', 'Por que nós', 'Fim']) expect(full).toContain(title);
    // sem identidade (documento simples), nada é removido
    expect(renderDocument('<h2>A</h2><h2>B</h2>', data, [], 'detalhado')).toBe('<h2>A</h2><h2>B</h2>');
  });

  it('CPF', () => {
    expect(validCpf('529.982.247-25')).toBe(true);
    expect(validCpf('52998224724')).toBe(false);
    expect(validCpf('11111111111')).toBe(false);
    expect(validCpf('123')).toBe(false);
  });
});
