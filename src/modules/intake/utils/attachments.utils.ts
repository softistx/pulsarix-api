// Keys stored before the file fields existed lack them: the mongo layer applies
// no schema default on read, so every reader goes through this.
export const attachmentsOn = (key: { attachmentsEnabled?: boolean }) =>
  key.attachmentsEnabled !== false;
