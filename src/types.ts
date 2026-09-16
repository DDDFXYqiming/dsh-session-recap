/**
 * Wire types shared by the host sidecar route and the Web client.
 *
 * @module @dsh-external/dsh-session-recap/types
 */

/** The latest recap snapshot for one live session. */
export interface RecapProjection {
  /** Generated recap text. */
  text: string
  /** Unix epoch milliseconds when the recap was generated. */
  at: number
  /** Seq of the turn/end this recap summarizes; null for a pre-turn manual recap. */
  turnSeq: number | null
}

/** Response returned by the same-origin recap route. */
export interface RecapResponse {
  recap: RecapProjection | null
  /**
   * Whether the host still owns the `recap` slash name. The Web client registers
   * its own slash row only when the host has released the name: the two must
   * never coexist, because a host/contribution name collision fails the whole
   * command menu rather than shadowing one row.
   */
  hostRecap: boolean
}
