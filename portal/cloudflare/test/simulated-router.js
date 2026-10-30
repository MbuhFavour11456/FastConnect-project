const allowedProfiles = new Set(["plan-10-days", "plan-30-days"]);
const macAddressPattern = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

export class SimulatedRouter {
  #users = new Map();

  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
  }

  apply(command) {
    if (
      command === null ||
      typeof command !== "object" ||
      typeof command.id !== "string" ||
      !macAddressPattern.test(command.macAddress)
    ) {
      throw new Error("Simulated router received an invalid command");
    }

    if (command.action === "grant") {
      if (
        !allowedProfiles.has(command.profile) ||
        typeof command.expiresAt !== "string" ||
        Number.isNaN(Date.parse(command.expiresAt)) ||
        Date.parse(command.expiresAt) <= this.clock().getTime()
      ) {
        throw new Error("Simulated router refused an invalid or expired grant");
      }

      this.#users.set(command.macAddress, {
        profile: command.profile,
        expiresAt: command.expiresAt,
      });
      return { result: "applied" };
    }

    if (command.action === "revoke") {
      this.#users.delete(command.macAddress);
      return { result: "applied" };
    }

    throw new Error("Simulated router refused an unsupported action");
  }

  getUser(macAddress) {
    return this.#users.get(macAddress) ?? null;
  }

  get size() {
    return this.#users.size;
  }
}
