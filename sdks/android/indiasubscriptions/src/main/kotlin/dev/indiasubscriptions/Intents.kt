package dev.indiasubscriptions

import android.content.Intent
import dev.indiasubscriptions.models.PurchaseSession

/**
 * Hands the link an activity was opened with to [PurchaseClient.handleReturnLink]. Call it from `onCreate` (for the
 * intent the activity was started with) and from `onNewIntent`. An intent that carries no link gives
 * [ReturnLinkResult.Ignored].
 */
public suspend fun PurchaseClient.handleReturnLink(intent: Intent?): ReturnLinkResult {
    val link = intent?.dataString ?: return ReturnLinkResult.Ignored
    return handleReturnLink(link)
}

/** The session a [ReturnLinkResult] is about, if it names one. */
public val ReturnLinkResult.session: PurchaseSession?
    get() = when (this) {
        is ReturnLinkResult.Completed -> session
        is ReturnLinkResult.NotPaid -> session
        is ReturnLinkResult.StillPending -> session
        ReturnLinkResult.Ignored, is ReturnLinkResult.BackendFailed -> null
    }
