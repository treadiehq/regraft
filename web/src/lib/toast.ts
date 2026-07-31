import { readonly, ref } from "vue";

export interface Toast {
  id: number;
  tone: "ok" | "warn" | "error";
  text: string;
}

const toasts = ref<Toast[]>([]);
let nextId = 1;

export function useToasts() {
  return readonly(toasts);
}

export function toast(tone: Toast["tone"], text: string, ttl = 4200): void {
  const id = nextId;
  nextId += 1;
  toasts.value = [...toasts.value, { id, tone, text }];
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }, ttl);
}
