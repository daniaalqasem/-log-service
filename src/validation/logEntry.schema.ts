import { z } from 'zod';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export const logEntrySchema = z.object({
  timestamp: z
    .string()
    .datetime()
    .refine(
      (value) => {
        const entryTime = new Date(value).getTime();
        const maxAllowedTime = Date.now() + FIVE_MINUTES_MS;
        return entryTime <= maxAllowedTime;
      },
      { message: 'timestamp must not be more than five minutes in the future' }
    ),

  level: z.enum(['debug', 'info', 'warn', 'error'], {
    message: 'invalid level',
  }),

  service: z.string().min(1, { message: 'service must be a non-empty string' }),

  message: z.string().min(1, { message: 'message must be a non-empty string' }),

 
attributes: z
  .record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()], {
      message: 'attribute values must be string, number, or boolean',
    })
  )
  .optional(),

});

export type LogEntryInput = z.infer<typeof logEntrySchema>;

export const ingestRequestSchema = z.object({
  logs: z.array(z.unknown()).min(1),
});