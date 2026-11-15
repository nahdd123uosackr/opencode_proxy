import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  apiKeys: defineTable({
    key: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    active: v.boolean(),
  }).index("by_active", ["active"]),
});