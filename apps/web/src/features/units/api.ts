import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  routes,
  unit,
  paged,
  type Unit,
  type CreateUnitBody,
  type UpdateUnitBody,
} from '@rms/contract';
import { request } from '@/lib/api';

export const unitsKeys = {
  all: ['units'] as const,
  list: (propertyId: string) => [...unitsKeys.all, 'list', propertyId] as const,
  detail: (id: string) => [...unitsKeys.all, 'detail', id] as const,
};

const unitList = paged(unit);

export function useUnits(propertyId: string) {
  return useQuery({
    queryKey: unitsKeys.list(propertyId),
    queryFn: ({ signal }) =>
      request(routes.units.list(propertyId), { schema: unitList, signal }),
    enabled: propertyId.length > 0,
  });
}

export function useCreateUnit(propertyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUnitBody) =>
      request(routes.units.create(propertyId), { method: 'POST', body, schema: unit }),
    onSuccess: (created: Unit) => {
      void queryClient.invalidateQueries({ queryKey: unitsKeys.list(propertyId) });
      queryClient.setQueryData(unitsKeys.detail(created.id), created);
      // Unit counts live on the property record (unitCount / occupiedUnitCount).
      void queryClient.invalidateQueries({ queryKey: ['properties', 'detail', propertyId] });
    },
  });
}

export function useUpdateUnit(propertyId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateUnitBody) =>
      request(routes.units.update(id), { method: 'PATCH', body, schema: unit }),
    onSuccess: (updated: Unit) => {
      void queryClient.invalidateQueries({ queryKey: unitsKeys.list(propertyId) });
      queryClient.setQueryData(unitsKeys.detail(id), updated);
      void queryClient.invalidateQueries({ queryKey: ['properties', 'detail', propertyId] });
    },
  });
}

export function useDeleteUnit(propertyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request(routes.units.remove(id), { method: 'DELETE', schema: z.void() }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: unitsKeys.list(propertyId) });
      queryClient.removeQueries({ queryKey: unitsKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: ['properties', 'detail', propertyId] });
    },
  });
}
