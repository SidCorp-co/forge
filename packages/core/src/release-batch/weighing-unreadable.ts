/** ISS-1368 — which read of the weighing failed; importless, so a hold can name it cheaply. */
export type WeighingSubject = 'declaration' | 'runners' | 'repository' | 'verdicts';

export class WeighingUnreadable extends Error {
  readonly subject: WeighingSubject;
  constructor(subject: WeighingSubject, message: string) {
    super(message);
    this.name = 'WeighingUnreadable';
    this.subject = subject;
  }
}
