export type HelpActor = {
  userId: number;
  companyId: number;
  permissions: string[];
};

/** Eventos aceitos em POST /help/events (uso dos tutoriais em vídeo: abrir, assistir, pular capítulo, terminar). */
export const HELP_EVENTS = [
  'help_open',
  'lesson_start',
  'lesson_complete',
  'lesson_exit',
  'video_play',
  'chapter_jump',
] as const;

/** Ids dos tutoriais: "comercial.propostas". */
export const isLessonId = (value: string) =>
  /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(value);
