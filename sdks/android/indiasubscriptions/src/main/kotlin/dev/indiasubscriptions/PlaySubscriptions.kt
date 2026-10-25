package dev.indiasubscriptions

import android.content.Context
import android.content.Intent
import android.net.Uri

/** Links to Google Play's subscription management pages. A subscription bought through Google Play is cancelled or paused there. */
public object PlaySubscriptions {
    /** The page that lists every Google Play subscription of the customer. */
    public const val CENTER_URL: String = "https://play.google.com/store/account/subscriptions"

    /**
     * The management page of one subscription (the recommended link), or the list when [productId] is null. [productId]
     * is the Play Console subscription product id, which a session's Google Play option carries.
     */
    public fun managementUrl(packageName: String, productId: String? = null): String {
        if (productId == null) return CENTER_URL
        return Uri.parse(CENTER_URL).buildUpon()
            .appendQueryParameter("sku", productId)
            .appendQueryParameter("package", packageName)
            .build()
            .toString()
    }

    /** An intent that opens [managementUrl] (in the Play Store app where it handles the address, else the browser). */
    public fun managementIntent(context: Context, productId: String? = null): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(managementUrl(context.packageName, productId)))
}
