type ChangeEntry = {
  column: string;
  oldValue: any;
  newValue: any;
};

/**
 * Compara dois objetos e retorna as diferenças em formato de array
 * @param oldValues Valores originais antes da atualização
 * @param newValues Valores após a atualização
 * @param ignoreKeys Chaves para ignorar na comparação (ex: ['id', 'createdAt'])
 */
export const getChanges = (
  oldValues: Record<string, any>,
  newValues: Record<string, any>,
  ignoreKeys: string[] = ['id', 'createdAt', 'updatedAt'],
): Array<{
  column: string;
  oldValue: any;
  newValue: any;
}> => {
  if (!oldValues || !newValues) return [];

  return Object.keys(oldValues)
    .filter((key) => !ignoreKeys.includes(key))
    .reduce((acc, key) => {
      if (`${oldValues[key]}` !== `${newValues[key]}`) {
        acc.push({
          column: key,
          oldValue: oldValues[key],
          newValue: newValues[key],
        });
      }
      return acc;
    }, [] as ChangeEntry[]);
};
