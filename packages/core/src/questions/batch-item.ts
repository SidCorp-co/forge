export function batchItemRefusal(questionId: string, batchId: string) {
  return [
    `question ${questionId} is an item of questionnaire ${batchId}; answer it with its batch (POST …/questionnaires/${batchId}/answers)`,
    'QUESTION_IN_QUESTIONNAIRE',
  ] as const;
}
