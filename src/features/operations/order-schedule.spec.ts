import { donePercent, parseSchedule, plannedPercent, projectEnd, scheduleEnd, stepDates, stepsOn } from './order-schedule';

describe('cronograma da OS em datas', () => {
  const schedule = { unit: 'dia', steps: [{ title: 'Mobilização', start: 1, duration: 2 }, { title: 'Execução', start: 3, duration: 8 }] };

  it('dá as datas de cada etapa a partir do início', () => {
    expect(stepDates(schedule, '2026-11-25').map((step) => [step.title, step.from, step.to])).toEqual([
      ['Mobilização', '2026-11-25', '2026-11-26'], ['Execução', '2026-11-27', '2026-12-04'],
    ]);
    expect(scheduleEnd(schedule, '2026-11-25')).toBe('2026-12-04');
    expect(stepDates(schedule, null)[0]).toMatchObject({ from: null, to: null });
  });

  it('em semanas, cada unidade vale 7 dias', () => {
    expect(stepDates({ unit: 'semana', steps: [{ title: 'A', start: 2, duration: 1 }] }, '2026-11-02')[0]).toMatchObject({ from: '2026-11-09', to: '2026-11-15' });
  });

  it('diz quais etapas estão previstas num dia', () => {
    expect(stepsOn(schedule, '2026-11-25', '2026-11-26')).toEqual([0]);
    expect(stepsOn(schedule, '2026-11-25', '2026-11-27')).toEqual([1]);
    expect(stepsOn(schedule, '2026-11-25', '2026-12-10')).toEqual([]);
    expect(stepsOn(schedule, null, '2026-11-25')).toEqual([]);
  });

  it('previsto e feito são pesados pela duração', () => {
    expect(plannedPercent(schedule, '2026-11-25', '2026-11-26')).toBe(20);
    expect(plannedPercent(schedule, '2026-11-25', '2026-12-04')).toBe(100);
    expect(donePercent(schedule, new Map([[0, 100], [1, 50]]))).toBe(60);
    expect(donePercent({ steps: [] }, new Map())).toBeNull();
  });

  it('projeta o término pelo ritmo', () => {
    // 30% em 3 dias = 10%/dia: faltam 70% = 7 dias depois do último RDO
    expect(projectEnd('2026-11-25', 30, '2026-11-27', '2026-12-04')).toEqual({ date: '2026-12-04', delayDays: 0, ratePerDay: 10 });
    expect(projectEnd('2026-11-25', 20, '2026-11-27', '2026-12-04').delayDays).toBe(5);
    expect(projectEnd('2026-11-25', 0, '2026-11-27', null)).toEqual({ date: null, delayDays: null, ratePerDay: null });
  });

  it('valida o cronograma vindo da tela', () => {
    expect(parseSchedule({ unit: 'xx', steps: [{ title: ' Etapa  1 ', start: '1', duration: 2, details: 'subir andaime' }] })).toEqual({ unit: 'dia', steps: [{ title: 'Etapa 1', start: 1, duration: 2, details: 'subir andaime' }] });
    expect(() => parseSchedule({ steps: [{ title: '', start: 1, duration: 1 }] })).toThrow('informe o nome');
    expect(() => parseSchedule({ steps: [{ title: 'A', start: 0, duration: 1 }] })).toThrow('início');
    expect(() => parseSchedule({ steps: 'x' })).toThrow('inválido');
  });
});
