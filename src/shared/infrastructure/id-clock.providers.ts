import { uuidv7 } from 'uuidv7';
import type { IdGeneratorPort } from '../application/ports/id-generator-port';
import type { ClockPort } from '../application/ports/clock-port';

export class UuidV7Generator implements IdGeneratorPort {
  newId(): string {
    return uuidv7();
  }
}

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}
