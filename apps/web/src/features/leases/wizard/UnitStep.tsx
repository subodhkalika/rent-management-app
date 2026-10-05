import { useState } from 'react';
import { unitStatusLabels, type Unit } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useProperties } from '@/features/properties/api';
import { useUnits } from '@/features/units/api';
import type { WizardForm } from './types';

interface UnitStepProps {
  form: WizardForm;
  onUnitSelected: (unit: Unit) => void;
}

/** Step 1: pick a property, then a unit within it. Every other step needs the
 *  unit's property (for currency, timezone, calendar and move-out policy), so this
 *  is the step that resolves it. */
export function UnitStep({ form, onUnitSelected }: UnitStepProps) {
  const [propertyId, setPropertyId] = useState('');
  const propertiesQuery = useProperties();
  const properties = propertiesQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const unitsQuery = useUnits(propertyId);
  const units = unitsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const selectedUnitId = form.watch('unitId');

  return (
    <div className="space-y-4">
      <div className="grid gap-1.5">
        <label htmlFor="wizard-property" className="text-sm font-medium">
          Property
        </label>
        {propertiesQuery.isPending ? (
          <Skeleton className="h-9 w-full" />
        ) : properties.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You don't have any properties yet. Add one before creating a lease.
          </p>
        ) : (
          <Select
            value={propertyId}
            onValueChange={(value) => {
              setPropertyId(value);
              form.setValue('unitId', '', { shouldValidate: false });
            }}
          >
            <SelectTrigger id="wizard-property" className="w-full">
              <SelectValue placeholder="Select a property" />
            </SelectTrigger>
            <SelectContent>
              {properties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {propertyId && (
        <div className="grid gap-1.5">
          <span className="text-sm font-medium" id="wizard-unit-label">
            Unit
          </span>
          {unitsQuery.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : unitsQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn't load units for this property: {unitsQuery.error.message}
            </p>
          ) : units.length === 0 ? (
            <p className="text-sm text-muted-foreground">This property has no units yet.</p>
          ) : (
            <RadioGroup
              aria-labelledby="wizard-unit-label"
              value={selectedUnitId}
              onValueChange={(unitId) => {
                const unit = units.find((u) => u.id === unitId);
                if (!unit) return;
                form.setValue('unitId', unit.id, { shouldValidate: true });
                onUnitSelected(unit);
              }}
              className="gap-2"
            >
              {units.map((unit) => (
                <label
                  key={unit.id}
                  htmlFor={`wizard-unit-${unit.id}`}
                  className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary"
                >
                  <span className="flex items-center gap-3">
                    <RadioGroupItem value={unit.id} id={`wizard-unit-${unit.id}`} />
                    <span>
                      <span className="block font-medium">{unit.label}</span>
                      <span className="block text-muted-foreground">
                        {unit.bedrooms} bd / {unit.bathrooms} ba
                      </span>
                    </span>
                  </span>
                  <Badge variant={unit.status === 'occupied' ? 'default' : 'secondary'}>
                    {unitStatusLabels[unit.status]}
                  </Badge>
                </label>
              ))}
            </RadioGroup>
          )}
          {units.some((u) => u.id === selectedUnitId && u.status === 'occupied') && (
            <p className="text-sm text-muted-foreground">
              This unit already has an active lease. You can still draft this one, but
              activating it will be blocked until the current lease ends.
            </p>
          )}
        </div>
      )}

      {form.formState.errors.unitId && (
        <p role="alert" className="text-sm text-destructive">
          {form.formState.errors.unitId.message}
        </p>
      )}
    </div>
  );
}
