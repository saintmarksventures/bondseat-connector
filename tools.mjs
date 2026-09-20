import { z } from 'zod';

const reference = { kind: z.enum(['monitor', 'scheduled']), id: z.string().uuid() };
export const tools = [
  ['restaurants', 'Find restaurants by name and city/neighborhood, or a Resy URL. BondSeat uses its venue lookup and adds missing verified venues automatically. Check name and location; clarify ambiguous matches. Empty input lists the directory; follow nextCursor with cursor.', { q: z.string().min(2).max(120).optional(), city: z.string().min(2).max(120).optional(), url: z.string().url().optional(), cursor: z.string().optional() }, false],
  ['request', 'Start one persistent booking request using a restaurant name plus city/neighborhood, a Resy URL, or a returned restaurantId. BondSeat resolves missing venues automatically; ambiguous matches return choices without starting work. Existing user instructions can authorize it; do not ask again when a table appears. Show any setupUrl to the diner, then schedule status checks to finish setup and report the booking outcome; this connector does not push updates. Identical dining details reuse the original request. Never use this tool to repair a payment or credential problem.', {
    restaurantId: z.string().optional(), restaurant: z.string().min(2).max(120).optional(), city: z.string().min(2).max(120).optional(), restaurantUrl: z.string().url().optional(), partySize: z.number().int().min(1).max(20), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/), endTime: z.string().regex(/^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/),
    mode: z.enum(['monitor', 'scheduled']).optional(), executeAt: z.string().datetime({ offset: true }).optional(),
    cancelFeeProtectionHours: z.number().int().min(1).max(168).optional(), confirmed: z.literal(true),
  }, false],
  ['status', 'Read booking status. Without an ID, finish pending setup. Schedule follow-up calls after pollAfterSeconds until terminal or user action is needed, then notify the diner. Follow agentInstruction. This tool does not run background checks. If the runtime cannot schedule follow-ups, say so. Credentials are managed automatically. FIRED monitor outcome or SUCCEEDED scheduled status means booked.', { kind: reference.kind.optional(), id: reference.id.optional() }, true],
  ['requests', 'List existing booking requests. Follow nextCursor with cursor.', { kind: reference.kind.optional(), cursor: z.string().optional() }, true],
  ['stop', 'Stop future attempts when requested. This cannot cancel a restaurant reservation; an in-flight booking may finish. Follow agentInstruction and nextAction: verify_provider means ask the diner to check their reservations with the provider, without claiming no booking exists.', reference, false],
  ['resume', 'Resume the same unfinished monitor after user authorization. If credentials are required, show nextAction to reconnect first. Never resumes successful bookings.', reference, false],
  ['connect', 'Restore access to existing bookings without starting or resuming a request. Show setupUrl to the diner, then use status.', {}, false],
];
