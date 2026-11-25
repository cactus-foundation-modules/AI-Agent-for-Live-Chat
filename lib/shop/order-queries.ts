import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getShopConfigCached, type ShpConfig } from '@/modules/shop/lib/config'
import type { ShpOrderStatus } from '@/modules/shop/lib/types'
import { formatPrice } from './product-format'
import { proformaAvailable } from '@/modules/shop/lib/proforma'
import { getPaymentProvider, resolveProviderLabel } from '@/modules/shop/lib/payments/registry'
import { manualPaymentInstructions, paymentOutstanding } from '@/modules/shop/lib/payment-instructions'
import { settlementMethod } from '@/modules/shop/lib/order-pay-online'
import type { ShpDeliveryDelay, ShpPaymentStatus } from '@/modules/shop/lib/types'
import { deliveryBookingForShipment } from '@/modules/shop/lib/delivery-slot'
import { parcelCourierTimesEmailable } from '@/modules/shop/lib/tracking/provisional-window'
import { orderPaperwork } from './payment-words'
import {
  claimMatchesOrder,
  orderStatusWords,
  trackingStageWords,
  type OrderClaim,
  type OrderIdentity,
} from './order-verify'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { parseConsignmentParcels } from '@/modules/shop/lib/consignment-parcels-schema'
import { describeDeliveryMoment, describeParcels, describePlaced, summariseParcels, type ParcelFacts } from './delivery-words'
import { normaliseCompany, normaliseOrderNumber, normalisePostcode, orderNumbersMatch, postcodeMatchKey, splitOrderNumber } from './text'
import {
  chargeStatusWords,
  describeRequest,
  distinctEmails,
  lineChoices,
  refundStatusWords,
  type RequestFacts,
} from './order-detail'

// Copied from the phone assistant (modules/ai-call-answering/lib/order-queries.ts) and
// kept in step by hand: the two modules never import each other. Adapted for
// a chat window where the words the model reads differ.
// ---------------------------------------------------------------------------
// Looking an order up for a visitor who has said who they are.
//
// Two ways in. A signed-in member's own orders (shp_orders.member_id) need no
// further proof, and only orders on their account are ever found that way.
// Anybody else proves an order: candidates are found by whatever identifier
// they gave, then EVERY candidate is checked against the full claim in
// order-verify.ts. Only an order that passes is read in detail, and the detail
// deliberately leaves out email, phone, street address and tracking numbers -
// a visitor who has proved the postcode is told the town and the progress, not
// handed the customer record. Unlike the phone, no email address is ever handed
// to the model: an email goes to the address on the order it is about, chosen
// here, so there is never a list to read back.
// ---------------------------------------------------------------------------

const CANDIDATE_LIMIT = 25
/** Wider than CANDIDATE_LIMIT: the postcode-neighbourhood net holds many strangers. */
const FUZZY_CANDIDATE_LIMIT = 400
const MAX_ORDERS_RETURNED = 3
/** A member's recent orders listed by list_my_orders: enough to cover "the one
 *  from January" without turning the answer into a customer history. */
export const MAX_MEMBER_ORDERS_LISTED = 5
/** How far back a named order number is looked for on a member's account. */
const MAX_MEMBER_ORDERS_SEARCHED = 200

type CandidateRow = {
  id: string
  order_number: string
  customer_email: string
  customer_organisation: string | null
  shipping_address: unknown
}

function addressField(address: unknown, field: string): string | null {
  if (!address || typeof address !== 'object') return null
  const value = (address as Record<string, unknown>)[field]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

async function findCandidates(claim: OrderClaim): Promise<CandidateRow[]> {
  const columns = Prisma.sql`o."id", o."order_number", o."customer_email", o."customer_organisation", o."shipping_address"`
  const saleOnly = Prisma.sql`o."kind" = 'SALE'`

  if (claim.orderNumber?.trim()) {
    const wanted = normaliseOrderNumber(claim.orderNumber)
    if (wanted === '') return []
    // Also the same number without its prefix or padding zeros (DW000123 for
    // order 123); the prefix rule is applied afterwards in order-verify.ts.
    const bare = splitOrderNumber(claim.orderNumber)?.number ?? wanted
    return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT ${columns} FROM "shp_orders" o
      WHERE ${saleOnly} AND (
        regexp_replace(upper(o."order_number"), '[^A-Z0-9]', '', 'g') = ${wanted}
        OR ltrim(substring(o."order_number" from '([0-9]+)[^0-9]*$'), '0') = ${bare}
      )
      LIMIT ${CANDIDATE_LIMIT}
    `)
  }
  if (claim.email?.trim()) {
    return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT ${columns} FROM "shp_orders" o
      WHERE ${saleOnly} AND lower(o."customer_email") = ${claim.email.trim().toLowerCase()}
      ORDER BY o."created_at" DESC LIMIT ${CANDIDATE_LIMIT}
    `)
  }
  const company = normaliseCompany(claim.companyName ?? '')
  const firstWord = company.split(' ')[0] ?? ''
  if (firstWord.length < 2) return []
  const like = `%${firstWord.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT ${columns} FROM "shp_orders" o
    WHERE ${saleOnly}
      AND (o."customer_organisation" ILIKE ${like} OR o."shipping_address"->>'company' ILIKE ${like})
    ORDER BY o."created_at" DESC LIMIT ${CANDIDATE_LIMIT}
  `)
}

/** The wider net, cast only when nothing matched exactly: orders whose delivery
 *  postcode shares the start or the end of the one given (a single wrong
 *  character cannot spoil both), for the verifier to judge. Email and company
 *  claims only; an order number is already found by its digits. */
async function findFuzzyCandidates(claim: OrderClaim): Promise<CandidateRow[]> {
  if (claim.orderNumber?.trim()) return []
  const key = postcodeMatchKey(claim.postcode)
  const plain = normalisePostcode(claim.postcode)
  if (key.length < 6 || plain.length < 6) return []
  const held = Prisma.sql`regexp_replace(upper(o."shipping_address"->>'postcode'), '[^A-Z0-9]', '', 'g')`
  return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT o."id", o."order_number", o."customer_email", o."customer_organisation", o."shipping_address"
    FROM "shp_orders" o
    WHERE o."kind" = 'SALE'
      AND (left(${held}, 2) = ${plain.slice(0, 2)} OR right(${held}, 3) = ${plain.slice(-3)}
           OR left(${held}, 2) = ${key.slice(0, 2)} OR right(${held}, 3) = ${key.slice(-3)})
    ORDER BY o."created_at" DESC LIMIT ${FUZZY_CANDIDATE_LIMIT}
  `)
}

function identityOf(row: CandidateRow): OrderIdentity {
  return {
    orderNumber: row.order_number,
    customerEmail: row.customer_email,
    customerOrganisation: row.customer_organisation,
    shippingPostcode: addressField(row.shipping_address, 'postcode'),
    shippingCompany: addressField(row.shipping_address, 'company'),
  }
}

export type VerifiedOrder = {
  orderNumber: string
  placed: string
  /** When it was placed in words a caller recognises, for telling orders apart
   *  without an order number: "today", "yesterday", "on the 14th of January". */
  placedWords: string
  /** Month and year, for "is it the one from January". */
  placedMonth: string
  status: string
  payment: string
  total: string
  deliveringTo: string | null
  /** Money in words, as the order records it. Null where there is none. */
  breakdown: {
    subtotal: string
    discount: string | null
    couponCode: string | null
    delivery: string | null
    deliveryService: string | null
    tax: string | null
    paymentMethod: string | null
  }
  deliveryInstructions: string | null
  customerReference: string | null
  items: Array<{
    name: string
    quantity: number
    sku: string | null
    unitPrice: string
    lineTotal: string
    /** What was chosen on the line (colour, size, delivery option). */
    choices: string[]
    refundedQuantity: number
    preOrderDispatch: string | null
    returnable: boolean
    notReturnableBecause: string | null
  }>
  refunds: Array<{ amount: string; status: string; date: string }>
  requests: RequestFacts[]
  /** Extra charges raised on the order after it was placed. */
  extraCharges: Array<{ reason: string; total: string; status: string }>
  /** Notes the team left that the customer can see, newest first. */
  notesFromTeam: Array<{ date: string; text: string }>
  invoiceAvailable: boolean
  /** Whether the caller has a pro-forma invoice for it (a bank transfer order,
   *  say). Not a VAT invoice. */
  proformaAvailable: boolean
  /** What to tell the caller about the order's VAT invoice and pro-forma. */
  paperwork: string
  /** Where to send the money (bank details for a transfer), while this order
   *  still owes it on a method settled by hand. Null otherwise. */
  howToPay: string | null
  deliveries: Array<{
    carrier: string | null
    dispatched: string
    progress: string | null
    /** The day it is due, with the time window when there is one: the same
     *  booking the customer's order page shows (the day staff typed, or the
     *  courier's own day and window off their tracking). */
    expectedDelivery: string | null
    /** Words to say with the window when the courier's time is only their
     *  current estimate (AIT's tracking page shows a holding window until they
     *  confirm). Null when there is no window or it is firm. */
    timeWindowNote: string | null
    /** When the courier handed it over, day and time. For a delivery made up of
     *  several parcels this is left null: each parcel has its own in `parcels`. */
    deliveredOn: string | null
    /** Present only for a delivery the courier split into several parcels. */
    parcels: ParcelFacts[] | null
    parcelSummary: string | null
    /** A delay the courier or the team has flagged, in words. */
    delay: string | null
    signedBy: string | null
    outForDelivery: boolean
    stopsAway: number | null
    minutesAway: number | null
  }>
}

export type OrderLookupOutcome =
  | {
      matched: true
      orders: VerifiedOrder[]
      internalNumbers: string[]
    }
  | { matched: false }

type OrderRow = {
  id: string
  order_number: string
  status: ShpOrderStatus
  payment_status: string
  created_at: Date
  total: unknown
  subtotal: unknown
  discount_amount: unknown
  shipping_amount: unknown
  tax_amount: unknown
  coupon_code: string | null
  payment_method: string | null
  original_payment_method: string | null
  shipping_rate_name: string | null
  delivery_instructions: string | null
  customer_reference: string | null
  currency: string
  shipping_address: unknown
}

type ItemRow = {
  order_id: string
  product_name: string
  quantity: number
  product_sku: string | null
  unit_price: unknown
  total: unknown
  refunded_qty: number
  is_pre_order: boolean
  pre_order_dispatch_date: Date | null
  line_meta: unknown
  returnable: boolean
  non_returnable_note: string | null
}

type RefundRow = { order_id: string; amount: unknown; status: string; created_at: Date }
type RequestRow = { order_id: string; type: string; status: string; created_at: Date }
type ChargeRow = { order_id: string; reason: string; total: unknown; status: string }
type NoteRow = { order_id: string; content: string; created_at: Date }

type ShipmentRow = {
  order_id: string
  carrier: string | null
  courier_id: string | null
  shipped_at: Date
  tracking_stage: string | null
  delivery_date: string | null
  delivery_slot_start: string | null
  delivery_slot_end: string | null
  delivery_window_from: Date | null
  delivery_window_to: Date | null
  delivered_at: Date | null
  consignment_parcels: unknown
  delivery_delay: string | null
  delivery_delayed_from: string | null
  delivery_delay_note: string | null
  signed_by: string | null
  carrier_out_for_delivery: boolean | null
  drops_away: number | null
  minutes_to_stop: number | null
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Whether any shipment of this order has a real delivery date or courier window
 *  (or has been delivered), which makes the estimate on its lines redundant. */
function hasCourierDate(orderId: string, shipments: readonly ShipmentRow[]): boolean {
  return shipments.some((shipment) => shipment.order_id === orderId && (!!shipment.delivery_date || !!shipment.delivery_window_from || !!shipment.delivered_at))
}

function delayKind(value: string | null): ShpDeliveryDelay | null {
  return value === 'today' || value === 'rebooking' ? value : null
}

const PROVISIONAL_WINDOW_NOTE =
  "This time window is the courier's current estimate from their tracking. Give it as that, and say they may still adjust it before the day."

/** The day it is due and its window, merged exactly as the order page merges
 *  them: a slot typed on the parcel wins, else the courier's tracking window
 *  for the booked day (or their own day when none is typed). Reading only the
 *  typed columns left AIT's window out and the assistant said there was none
 *  (DW000288). The window is flagged when the courier's times are a holding
 *  estimate rather than a confirmed slot. */
function expected(
  row: ShipmentRow,
  timezone: string,
  config: Pick<ShpConfig, 'deliveryCouriers'>,
): { expectedDelivery: string | null; timeWindowNote: string | null } {
  const booking = deliveryBookingForShipment({
    deliveryDate: row.delivery_date,
    deliverySlotStart: row.delivery_slot_start,
    deliverySlotEnd: row.delivery_slot_end,
    deliveryWindowFrom: row.delivery_window_from,
    deliveryWindowTo: row.delivery_window_to,
    deliveryDelay: delayKind(row.delivery_delay),
    deliveryDelayedFrom: row.delivery_delayed_from,
    deliveredAt: row.delivered_at,
  }, timezone)
  if (!booking.date) return { expectedDelivery: null, timeWindowNote: null }
  if (!booking.slotStart || !booking.slotEnd) return { expectedDelivery: booking.date, timeWindowNote: null }
  // A slot typed on the parcel, or read from the courier's own email, is firm;
  // only a window that came off the tracking page can be a holding one.
  const typed = row.delivery_slot_start === booking.slotStart && row.delivery_slot_end === booking.slotEnd
  const firm = typed || parcelCourierTimesEmailable(config, { courierId: row.courier_id, carrier: row.carrier })
  return {
    expectedDelivery: `${booking.date}, between ${booking.slotStart} and ${booking.slotEnd}`,
    timeWindowNote: firm ? null : PROVISIONAL_WINDOW_NOTE,
  }
}

export async function lookupOrders(claim: OrderClaim): Promise<OrderLookupOutcome> {
  const matching = (rows: CandidateRow[]) => rows.filter((row) => claimMatchesOrder(claim, identityOf(row)))
  let passed = matching(await findCandidates(claim))
  if (passed.length === 0) passed = matching(await findFuzzyCandidates(claim))
  if (passed.length === 0) return { matched: false }
  return readOrders(passed.slice(0, MAX_ORDERS_RETURNED).map((row) => row.id))
}

function money(value: unknown, order: OrderRow, symbol: string): string {
  return formatPrice(Number(value), order.currency === 'GBP' ? symbol : `${order.currency} `)
}

function moneyOrNull(value: unknown, order: OrderRow, symbol: string): string | null {
  return Number(value) > 0 ? money(value, order, symbol) : null
}

function delayWords(row: ShipmentRow): string | null {
  const parts = [row.delivery_delay?.trim(), row.delivery_delay_note?.trim()].filter((part): part is string => !!part)
  return parts.length > 0 ? parts.join(': ') : null
}

/** The address on each order, distinct, for orders the visitor has proved.
 *  Server side only: it decides where an email goes and never reaches the
 *  model. */
export async function emailsOnOrders(orderNumbers: readonly string[]): Promise<string[]> {
  if (orderNumbers.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ customer_email: string }>>(Prisma.sql`
    SELECT "customer_email" FROM "shp_orders"
    WHERE "kind" = 'SALE' AND "order_number" IN (${Prisma.join([...orderNumbers])})
    ORDER BY "created_at" DESC
  `)
  return distinctEmails(rows.map((row) => row.customer_email))
}

/** The address and name on one order, for emailing its customer. Null when the
 *  order is not there. */
export async function contactOnOrder(orderNumber: string): Promise<{ email: string; name: string } | null> {
  const rows = await prisma.$queryRaw<Array<{ customer_email: string; customer_name: string | null }>>`
    SELECT "customer_email", "customer_name" FROM "shp_orders"
    WHERE "kind" = 'SALE' AND "order_number" = ${orderNumber}
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return { email: row.customer_email.trim(), name: row.customer_name?.trim() ?? '' }
}

/** The name on the newest proved order using this address, for greeting
 *  whoever a note goes to when it goes to the address on their order. '' for
 *  none. Restated from the phone assistant (nameOnOrderEmail). */
export async function nameOnOrderEmail(orderNumbers: readonly string[], email: string): Promise<string> {
  if (orderNumbers.length === 0) return ''
  const rows = await prisma.$queryRaw<Array<{ customer_name: string | null }>>(Prisma.sql`
    SELECT "customer_name" FROM "shp_orders"
    WHERE "kind" = 'SALE' AND "order_number" IN (${Prisma.join([...orderNumbers])}) AND lower("customer_email") = ${email.trim().toLowerCase()}
    ORDER BY "created_at" DESC LIMIT 1
  `)
  return rows[0]?.customer_name?.trim() ?? ''
}

/** The phone numbers on proved orders, for texting their customer: the number
 *  chosen for updates first, then the customer's own. Read here and handed to
 *  the text tool only, never to the model. */
export async function phonesOnOrders(orderNumbers: readonly string[]): Promise<Array<{ orderNumber: string; phones: string[] }>> {
  if (orderNumbers.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ order_number: string; notify_phone: string | null; customer_phone: string | null }>>(Prisma.sql`
    SELECT "order_number", "notify_phone", "customer_phone" FROM "shp_orders"
    WHERE "kind" = 'SALE' AND "order_number" IN (${Prisma.join([...orderNumbers])})
    ORDER BY "created_at" DESC
  `)
  return rows.map((row) => ({
    orderNumber: row.order_number,
    phones: [row.notify_phone, row.customer_phone].map((phone) => phone?.trim() ?? '').filter((phone) => phone !== ''),
  }))
}

/** One of a signed-in member's own orders, by the number they gave (with or
 *  without the prefix and padding zeros), read in full. Only orders on their
 *  account are searched, so a number that is somebody else's finds nothing. */
export async function lookupMemberOrder(memberId: string, orderNumber: string): Promise<OrderLookupOutcome> {
  const rows = await prisma.$queryRaw<Array<{ id: string; order_number: string }>>`
    SELECT o."id", o."order_number" FROM "shp_orders" o
    WHERE o."kind" = 'SALE' AND o."member_id" = ${memberId}
    ORDER BY o."created_at" DESC LIMIT ${MAX_MEMBER_ORDERS_SEARCHED}
  `
  const hit = rows.find((row) => orderNumbersMatch(orderNumber, row.order_number))
  if (!hit) return { matched: false }
  return readOrders([hit.id])
}

export type MemberOrderSummary = {
  orderNumber: string
  placedWords: string
  status: string
  total: string
  itemCount: number
}

/** A signed-in member's newest orders, summary only: enough to tell which one
 *  they mean. Nothing is verified by listing; the detail comes from
 *  lookupMemberOrder. */
export async function listMemberOrders(memberId: string): Promise<MemberOrderSummary[]> {
  const [rows, config, timezone] = await Promise.all([
    prisma.$queryRaw<Array<{ order_number: string; status: string; payment_status: string; created_at: Date; total: unknown; currency: string; items: unknown }>>`
      SELECT o."order_number", o."status", o."payment_status", o."created_at", o."total", o."currency",
             (SELECT COALESCE(SUM(i."quantity"), 0)::int FROM "shp_order_items" i WHERE i."order_id" = o."id") AS "items"
      FROM "shp_orders" o
      WHERE o."kind" = 'SALE' AND o."member_id" = ${memberId}
      ORDER BY o."created_at" DESC LIMIT ${MAX_MEMBER_ORDERS_LISTED}
    `,
    getShopConfigCached(),
    getSiteTimezone(),
  ])
  return rows.map((row) => ({
    orderNumber: row.order_number,
    placedWords: describePlaced(row.created_at, timezone),
    status: orderStatusWords(row.status, row.payment_status),
    total: formatPrice(Number(row.total), row.currency === 'GBP' ? config.currencySymbol : `${row.currency} `),
    itemCount: Number(row.items) || 0,
  }))
}

/** Each order's payment method by the name the shop gives it today, as the
 *  checkout and the order page say it. A method no longer installed falls back
 *  to its code in plain words rather than to nothing. */
async function paymentMethodNames(orders: readonly OrderRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(orders.map((order) => order.payment_method).filter((id): id is string => !!id))]
  const names = await Promise.all(ids.map(async (id) => {
    const provider = getPaymentProvider(id)
    return provider ? await resolveProviderLabel(provider) : id.trim().toLowerCase().replace(/_/g, ' ')
  }))
  return new Map(ids.map((id, i) => [id, names[i] ?? id]))
}

/** The words the order page prints under "how to pay" for this order, while it
 *  still prints them: an unpaid order on a method settled by hand, by the
 *  method it was placed with (shop's own rule, so the phone and the page never
 *  disagree). Null once paid, cancelled or refunded. */
function howToPayFor(config: Pick<ShpConfig, 'bankTransferInstructions' | 'cashInstructions'>, order: OrderRow): string | null {
  const payable = {
    status: order.status,
    // Shop's own column, read as text; settlementMethod only asks whether it is a paid one.
    paymentStatus: order.payment_status as ShpPaymentStatus,
    paymentMethod: order.payment_method ?? '',
    originalPaymentMethod: order.original_payment_method,
    total: String(order.total),
  }
  if (!paymentOutstanding(payable)) return null
  const words = manualPaymentInstructions(settlementMethod(payable), config)
  return words ? words.trim() : null
}

function proformaFor(config: Pick<ShpConfig, 'proformaEnabled'>, order: OrderRow): boolean {
  return proformaAvailable(config, {
    status: order.status,
    paymentMethod: order.payment_method ?? '',
    originalPaymentMethod: order.original_payment_method,
  })
}

async function readOrders(ids: string[]): Promise<OrderLookupOutcome> {
  const [orders, items, shipments, refunds, requests, charges, notes, invoices, config, timezone] = await Promise.all([
    prisma.$queryRaw<OrderRow[]>(Prisma.sql`
      SELECT o."id", o."order_number", o."status", o."payment_status", o."created_at", o."total", o."subtotal",
             o."discount_amount", o."shipping_amount", o."tax_amount", o."coupon_code", o."payment_method",
             o."original_payment_method", o."shipping_rate_name", o."delivery_instructions", o."customer_reference", o."currency", o."shipping_address"
      FROM "shp_orders" o WHERE o."id" IN (${Prisma.join(ids)}) ORDER BY o."created_at" DESC
    `),
    prisma.$queryRaw<ItemRow[]>(Prisma.sql`
      SELECT "order_id", "product_name", "quantity", "product_sku", "unit_price", "total", "refunded_qty",
             "is_pre_order", "pre_order_dispatch_date", "line_meta", "returnable", "non_returnable_note"
      FROM "shp_order_items" WHERE "order_id" IN (${Prisma.join(ids)})
    `),
    prisma.$queryRaw<ShipmentRow[]>(Prisma.sql`
      SELECT "order_id", "carrier", "courier_id", "shipped_at", "tracking_stage", "delivery_date",
             "delivery_slot_start", "delivery_slot_end", "delivery_window_from", "delivery_window_to",
             "delivered_at", "consignment_parcels",
             "delivery_delay"::text AS "delivery_delay", "delivery_delayed_from", "delivery_delay_note", "signed_by", "carrier_out_for_delivery", "drops_away", "minutes_to_stop"
      FROM "shp_shipments" WHERE "order_id" IN (${Prisma.join(ids)}) ORDER BY "shipped_at"
    `),
    prisma.$queryRaw<RefundRow[]>(Prisma.sql`
      SELECT "order_id", "amount", "status", "created_at" FROM "shp_refunds"
      WHERE "order_id" IN (${Prisma.join(ids)}) ORDER BY "created_at" DESC
    `),
    prisma.$queryRaw<RequestRow[]>(Prisma.sql`
      SELECT "order_id", "type", "status", "created_at" FROM "shp_order_requests"
      WHERE "order_id" IN (${Prisma.join(ids)}) ORDER BY "created_at" DESC
    `),
    prisma.$queryRaw<ChargeRow[]>(Prisma.sql`
      SELECT "order_id", "reason", "total", "status" FROM "shp_order_charges"
      WHERE "order_id" IN (${Prisma.join(ids)}) ORDER BY "created_at" DESC
    `),
    prisma.$queryRaw<NoteRow[]>(Prisma.sql`
      SELECT "order_id", "content", "created_at" FROM "shp_order_notes"
      WHERE "order_id" IN (${Prisma.join(ids)}) AND "is_internal" = false ORDER BY "created_at" DESC LIMIT 20
    `),
    prisma.$queryRaw<Array<{ order_id: string }>>(Prisma.sql`
      SELECT DISTINCT "order_id" FROM "shp_invoices"
      WHERE "order_id" IN (${Prisma.join(ids)}) AND "voided_at" IS NULL AND "superseded_at" IS NULL
    `),
    getShopConfigCached(),
    getSiteTimezone(),
  ])
  const symbol = config.currencySymbol
  const invoiced = new Set(invoices.map((row) => row.order_id))
  const methodNames = await paymentMethodNames(orders)

  const verified: VerifiedOrder[] = orders.map((order) => ({
    orderNumber: order.order_number,
    placed: day(order.created_at),
    placedWords: describePlaced(order.created_at, timezone),
    placedMonth: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: timezone }).format(order.created_at),
    status: orderStatusWords(order.status, order.payment_status),
    payment: order.payment_status.toLowerCase().replace(/_/g, ' '),
    total: money(order.total, order, symbol),
    deliveringTo: addressField(order.shipping_address, 'city'),
    breakdown: {
      subtotal: money(order.subtotal, order, symbol),
      discount: moneyOrNull(order.discount_amount, order, symbol),
      couponCode: order.coupon_code?.trim() || null,
      delivery: Number(order.shipping_amount) > 0 ? money(order.shipping_amount, order, symbol) : 'free',
      deliveryService: order.shipping_rate_name?.trim() || null,
      tax: moneyOrNull(order.tax_amount, order, symbol),
      paymentMethod: order.payment_method ? methodNames.get(order.payment_method) ?? null : null,
    },
    deliveryInstructions: order.delivery_instructions?.trim() || null,
    customerReference: order.customer_reference?.trim() || null,
    items: items
      .filter((item) => item.order_id === order.id)
      .map((item) => ({
        name: item.product_name,
        quantity: item.quantity,
        sku: item.product_sku?.trim() || null,
        unitPrice: money(item.unit_price, order, symbol),
        lineTotal: money(item.total, order, symbol),
        choices: lineChoices(item.line_meta, { dropDeliveryEstimate: hasCourierDate(order.id, shipments) }),
        refundedQuantity: item.refunded_qty,
        preOrderDispatch: item.is_pre_order && item.pre_order_dispatch_date ? day(item.pre_order_dispatch_date) : null,
        returnable: item.returnable,
        notReturnableBecause: item.returnable ? null : item.non_returnable_note?.trim() || null,
      })),
    refunds: refunds
      .filter((refund) => refund.order_id === order.id)
      .map((refund) => ({ amount: money(refund.amount, order, symbol), status: refundStatusWords(refund.status), date: day(refund.created_at) })),
    requests: requests.filter((request) => request.order_id === order.id).map(describeRequest),
    extraCharges: charges
      .filter((charge) => charge.order_id === order.id)
      .map((charge) => ({ reason: charge.reason, total: money(charge.total, order, symbol), status: chargeStatusWords(charge.status) })),
    notesFromTeam: notes
      .filter((note) => note.order_id === order.id)
      .slice(0, 5)
      .map((note) => ({ date: day(note.created_at), text: note.content.trim().slice(0, 500) })),
    invoiceAvailable: invoiced.has(order.id),
    proformaAvailable: proformaFor(config, order),
    paperwork: orderPaperwork(config, {
      invoiced: invoiced.has(order.id),
      proformaAvailable: proformaFor(config, order),
      cancelledOrRefunded: order.status === 'CANCELLED' || order.status === 'REFUNDED',
    }),
    howToPay: howToPayFor(config, order),
    deliveries: shipments
      .filter((shipment) => shipment.order_id === order.id)
      .map((shipment) => {
        const boxes = parseConsignmentParcels(shipment.consignment_parcels)
        const split = boxes !== null && boxes.length > 1
        const parcels = split ? describeParcels(boxes, timezone) : null
        return {
          carrier: shipment.carrier,
          dispatched: day(shipment.shipped_at),
          progress: trackingStageWords(shipment.tracking_stage),
          ...expected(shipment, timezone, config),
          deliveredOn: !split && shipment.delivered_at ? describeDeliveryMoment(shipment.delivered_at, timezone) : null,
          parcels,
          parcelSummary: parcels ? summariseParcels(parcels) : null,
          delay: delayWords(shipment),
          signedBy: shipment.delivered_at && shipment.signed_by?.trim() ? shipment.signed_by.trim() : null,
          outForDelivery: shipment.carrier_out_for_delivery === true && !shipment.delivered_at,
          stopsAway: shipment.carrier_out_for_delivery === true && !shipment.delivered_at ? shipment.drops_away : null,
          minutesAway: shipment.carrier_out_for_delivery === true && !shipment.delivered_at ? shipment.minutes_to_stop : null,
        }
      }),
  }))
  return {
    matched: true,
    orders: verified,
    internalNumbers: verified.map((order) => order.orderNumber),
  }
}
