export const questionStatuses = ['open', 'answered', 'void', 'expired', 'needs_info'] as const;
export type QuestionStatus = (typeof questionStatuses)[number];

export const questionBlockerKinds = ['machine', 'master_or_peer', 'human'] as const;
export type QuestionBlockerKind = (typeof questionBlockerKinds)[number];

export const optionAuthorities = ['writer', 'admin'] as const;
export const optionBindings = ['this_call', 'session', 'project'] as const;
export const optionExecutors = ['agent', 'core', 'human'] as const;

export const answerShapes = ['choice', 'free_text'] as const;
export type AnswerShape = (typeof answerShapes)[number];
