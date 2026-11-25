import { flagNotGenuine, handToColleague, noteUnanswered, saveCallbackTool } from './conversation-tools'
import {
  emailOrderLinkTool,
  emailSummaryTool,
  getVisitorHistoryTool,
  listMyOrdersTool,
  lookupOrderTool,
  raiseOrderRequestTool,
  saveQuoteTool,
  sendTextTool,
} from './order-tools'
import type { RegisteredTool } from './registry'
import {
  checkDeliveryPostcodeTool,
  chooseDeliveryTool,
  findBySkuTool,
  getFaqsTool,
  getPaymentInfoTool,
  getProductTool,
  getReviewsTool,
  listCategoriesTool,
  searchGuidesTool,
  searchPagesTool,
  searchProductsTool,
} from './shop-tools'

// Every tool the assistant has, in the order the model is shown them. The order
// is part of the prompt cache's key: append new tools at the end rather than
// slotting them in, so a release changes as little of the cached start as it
// can. See lib/tools/registry.ts.
export const TOOLS: readonly RegisteredTool[] = [
  handToColleague,
  flagNotGenuine,
  saveCallbackTool,
  noteUnanswered,
  searchProductsTool,
  findBySkuTool,
  getProductTool,
  listCategoriesTool,
  getFaqsTool,
  getPaymentInfoTool,
  lookupOrderTool,
  listMyOrdersTool,
  emailOrderLinkTool,
  emailSummaryTool,
  getVisitorHistoryTool,
  searchPagesTool,
  checkDeliveryPostcodeTool,
  getReviewsTool,
  searchGuidesTool,
  raiseOrderRequestTool,
  saveQuoteTool,
  sendTextTool,
  chooseDeliveryTool,
]
