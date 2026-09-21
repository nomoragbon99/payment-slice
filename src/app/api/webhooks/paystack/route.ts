import { handlePaystackWebhook } from "@/lib/paystack/webhook-handler";

// Paystack calls this server to server. It has NO session and NO same-origin check (the browser is not
// involved); the x-paystack-signature check on the raw body is what authenticates it. Only POST is exported,
// so every other method gets a 405. See src/lib/paystack/webhook-handler.ts for the rules.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handlePaystackWebhook(request, { secretKey: process.env.PAYSTACK_SECRET_KEY });
}
