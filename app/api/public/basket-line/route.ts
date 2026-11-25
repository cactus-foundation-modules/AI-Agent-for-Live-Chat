// GET /api/m/ai-agent-for-live-chat/public/basket-line?product=<id>&service=<key>
// The basket line meta that adds this product with this delivery service, as the
// shop's own basket picker would write it, or `{ meta: null }` where the shop
// does not offer that service for it. Asked by the chat's "Add to basket"
// (components/chat/ProductButtons.tsx) when a card names a chosen service.
//
// Public on purpose: nothing here is per-visitor or secret. It is the same
// product-and-service menu the shop's own basket shows anyone.
import { NextRequest, NextResponse } from 'next/server'
import { BasketLineQuery, basketLineMeta } from '@/modules/ai-agent-for-live-chat/lib/basket-line'
import { basketServiceMenus } from '@/modules/ai-agent-for-live-chat/lib/shop/delivery-choice'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const parsed = BasketLineQuery.safeParse({ product: params.get('product') ?? '', service: params.get('service') ?? '' })
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE })
  const { product, service } = parsed.data
  // basketServiceMenus answers an empty map, never a throw, when the basket
  // cannot be worked out: the visitor's button then adds without the service.
  const menus = await basketServiceMenus([product])
  return NextResponse.json({ meta: basketLineMeta(product, service, menus) }, { headers: NO_STORE })
}
