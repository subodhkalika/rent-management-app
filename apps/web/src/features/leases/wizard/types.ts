import type { UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { createLeaseBody, type CreateLeaseBody } from '@rms/contract';

export type WizardInput = z.input<typeof createLeaseBody>;
export type WizardForm = UseFormReturn<WizardInput, unknown, CreateLeaseBody>;

export { createLeaseBody };
export type { CreateLeaseBody };
