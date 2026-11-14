import { VERSION } from "../version.ts";
import type { Logger } from "./scheduler.ts";
import {
  installedApp,
  isCompiledBinary,
  type ReleaseSource,
  UpdateError,
  Updater,
  type UpdateStatus,
} from "./updates.ts";

const DAY = 24 * 60 * 60_000;

/**
 * Keeps an eye on new releases for the interface, and installs one when asked.
 *
 * The released binary checks once a day while the setting allows (`updates.check`); a run from
 * source never checks on its own, so development and tests make no requests. Installing replaces
 * the binary this process runs from, and the desktop app if it is in Applications; under launchd
 * the daemon then exits and launchd starts the new version.
 */
export class UpdateService {
  private status: UpdateStatus = { current: VERSION, available: false };
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly updater: Updater;

  constructor(
    private readonly options: {
      enabled(): boolean;
      logger: Logger;
      source?: ReleaseSource;
      publicKey?: string;
      /** For tests: whether this process may replace its own binary. */
      compiled?: boolean;
      /** Stops this process so its supervisor starts the new binary. */
      restart(): void;
    },
  ) {
    this.updater = new Updater({
      current: VERSION,
      ...(options.source && { source: options.source }),
      ...(options.publicKey && { publicKey: options.publicKey }),
    });
  }

  start(): void {
    if (!(this.options.compiled ?? isCompiledBinary())) return;
    const tick = () => {
      if (this.options.enabled()) this.check().catch(() => {});
    };
    setTimeout(tick, 60_000);
    this.timer = setInterval(tick, DAY);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  view(): UpdateStatus & { canInstall: boolean } {
    return { ...this.status, canInstall: this.options.compiled ?? isCompiledBinary() };
  }

  async check(): Promise<UpdateStatus & { canInstall: boolean }> {
    try {
      this.status = { ...(await this.updater.check()), checkedAt: Date.now() };
    } catch (error) {
      if (error instanceof UpdateError && error.code === "unpublished") {
        this.status = {
          current: VERSION,
          available: false,
          unpublished: true,
          checkedAt: Date.now(),
        };
        return this.view();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.status = { ...this.status, error: message, checkedAt: Date.now() };
      this.options.logger.error("update check failed", { error: message });
    }
    return this.view();
  }

  /** Installs the latest release; returns its version and whether the daemon restarts now. */
  async install(target = process.execPath): Promise<{ version: string; restarting: boolean }> {
    if (!(this.options.compiled ?? isCompiledBinary())) {
      throw new UpdateError("this is a run from source; update it with git pull");
    }
    const version = await this.updater.updateBinary(target);
    const app = installedApp();
    if (app) {
      try {
        await this.updater.updateApp(app);
      } catch (error) {
        // The daemon is updated either way; the app can be updated again later.
        this.options.logger.error("desktop app update failed", { error: String(error) });
      }
    }
    this.status = { current: VERSION, latest: version, available: false };
    const supervised = Boolean(process.env.XPC_SERVICE_NAME?.startsWith("dev.warren"));
    this.options.logger.info("update installed", { version, restarting: supervised });
    if (supervised) setTimeout(() => this.options.restart(), 500);
    return { version, restarting: supervised };
  }
}
