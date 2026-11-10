import type { Worker } from '../../../../packages/protocol/src/index.js';
import type { ChatLink } from '../../../../packages/bridge/src/chat-links.js';
import { replyTicketSchema, type ReplyTicket } from '../schemas/requests.js';

type TicketEntry = {
  ticket: ReplyTicket;
  epoch: number;
};

/** Bounded, one-use proof for an exact reply in one pinned task conversation and run. */
export class ReplyTickets {
  private tickets = new Map<string, TicketEntry>();

  constructor(private now = Date.now) {}

  issue(key: string, raw: ReplyTicket, epoch = 0): void {
    const ticket = replyTicketSchema.parse(raw);

    if (ticket.envelope.workerId !== ticket.workerId || ticket.envelope.projectId !== ticket.projectId) {
      throw new Error('The reply ticket belongs to another task or project.');
    }

    for (const [id, previous] of this.tickets) {
      if (previous.ticket.expiresAt < this.now() || previous.ticket.workerId === ticket.workerId) {
        this.tickets.delete(id);
      }
    }

    this.tickets.set(key, { ticket, epoch });

    while (this.tickets.size > 12) {
      const oldest = this.tickets.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      this.tickets.delete(oldest);
    }
  }

  read(key: string, workerId: string): ReplyTicket {
    let entry = this.tickets.get(key);

    if (entry && entry.ticket.expiresAt < this.now()) {
      this.tickets.delete(key);
      entry = undefined;
    }

    if (!entry || entry.ticket.workerId !== workerId) {
      throw new Error(
        'This reply preview expired or is no longer available. Read it again; this request did not execute anything.',
      );
    }

    return entry.ticket;
  }

  assertBinding(ticket: ReplyTicket, worker: Worker, link: ChatLink): void {
    const entry = [...this.tickets.values()].find((entry) => entry.ticket === ticket);

    if (
      !entry ||
      entry.epoch !== (worker.control?.epoch ?? 0) ||
      link.id !== ticket.link.id ||
      link.url !== ticket.link.url ||
      worker.id !== ticket.workerId ||
      worker.projectId !== ticket.projectId ||
      worker.goal !== ticket.goal
    ) {
      throw new Error('The task run or its linked conversation changed. Select the reply again.');
    }
  }

  consume(key: string): void {
    this.tickets.delete(key);
  }

  revoke(workerId: string): void {
    for (const [key, entry] of this.tickets) {
      if (entry.ticket.workerId === workerId) {
        this.tickets.delete(key);
      }
    }
  }

  clear(): void {
    this.tickets.clear();
  }
}
