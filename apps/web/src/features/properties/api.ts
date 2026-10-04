import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  routes,
  property,
  paged,
  type Property,
  type CreatePropertyBody,
  type UpdatePropertyBody,
} from '@rms/contract';
import { ApiClientError, request } from '@/lib/api';

export const propertiesKeys = {
  all: ['properties'] as const,
  list: () => [...propertiesKeys.all, 'list'] as const,
  detail: (id: string) => [...propertiesKeys.all, 'detail', id] as const,
};

const propertyList = paged(property);
type PropertyList = z.infer<typeof propertyList>;

export function useProperties() {
  return useQuery<PropertyList, ApiClientError>({
    queryKey: propertiesKeys.list(),
    queryFn: ({ signal }) => request(routes.properties.list(), { schema: propertyList, signal }),
  });
}

export function useProperty(id: string) {
  return useQuery<Property, ApiClientError>({
    queryKey: propertiesKeys.detail(id),
    queryFn: ({ signal }) => request(routes.properties.get(id), { schema: property, signal }),
    enabled: id.length > 0,
  });
}

export function useCreateProperty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePropertyBody) =>
      request(routes.properties.create(), { method: 'POST', body, schema: property }),
    onSuccess: (created: Property) => {
      void queryClient.invalidateQueries({ queryKey: propertiesKeys.list() });
      queryClient.setQueryData(propertiesKeys.detail(created.id), created);
    },
  });
}

export function useUpdateProperty(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdatePropertyBody) =>
      request(routes.properties.update(id), { method: 'PATCH', body, schema: property }),
    onSuccess: (updated: Property) => {
      void queryClient.invalidateQueries({ queryKey: propertiesKeys.list() });
      queryClient.setQueryData(propertiesKeys.detail(id), updated);
    },
  });
}

export function useDeleteProperty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request(routes.properties.remove(id), { method: 'DELETE', schema: z.void() }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: propertiesKeys.list() });
      queryClient.removeQueries({ queryKey: propertiesKeys.detail(id) });
    },
  });
}
