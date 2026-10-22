import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppContext } from '../context.js';
import { openDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import { EventBus } from '../events.js';
import { createLogger } from '../log.js';
import { loadConfig } from '../config.js';
import { SettingsStore } from '../settings.js';
import { DataReader } from '../crypto/keyring.js';

/** A real encrypted database in a temp dir, as the worker uses — for tests only. */
export async function makeCtx(): Promise<{
  ctx: AppContext;
  dir: string;
  events: EventBus;
  /** Reads what the tests wrote (the owner's key is generated here, so it can decrypt). */
  reader: DataReader;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ttl-test-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, SCRYPT_LOG_N: '10', TT_ENABLED: 'false', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv);
  const repo = new Repo(openDb(config.dbPath));
  const events = new EventBus();
  const ctx = new AppContext(config, createLogger('silent'), repo, events, new SettingsStore(repo, config.defaults));
  const { PRIVKEY_AAD, generateX25519, wrapPrivateKey } = await import('../crypto/keyring.js');
  const { derivePasswordKeys, deriveRecoveryKeys, generateRecoveryKey, newSalt } = await import('../crypto/password.js');
  const pwSalt = newSalt();
  const pw = await derivePasswordKeys('correct-horse-battery-staple', pwSalt, 10);
  const kp = generateX25519();
  const recovery = generateRecoveryKey();
  const recoverySalt = newSalt();
  const rk = deriveRecoveryKeys(recovery.bytes, recoverySalt);
  const now = Date.now();
  repo.createOwner({
    username: 'owner',
    pw_salt: pwSalt,
    pw_auth_hash: pw.authHash,
    public_key: kp.publicRaw,
    privkey_pw: wrapPrivateKey(pw.kek, kp.privatePkcs8, PRIVKEY_AAD.password),
    privkey_recovery: wrapPrivateKey(rk.kek, kp.privatePkcs8, PRIVKEY_AAD.recovery),
    recovery_salt: recoverySalt,
    recovery_auth_hash: rk.authHash,
    created_at: now,
    password_changed_at: now,
  });
  const reader = DataReader.fromPkcs8(repo, kp.privatePkcs8);
  // A background download can still be writing into the directory when a test ends (the engine's avatar fetch), and a
  // plain rm then fails with ENOTEMPTY; retrying is enough.
  return {
    ctx,
    dir,
    events,
    reader,
    cleanup: async () => {
      for (let i = 0; i < 5; i++) {
        try {
          await fs.rm(dir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 60));
        }
      }
    },
  };
}
