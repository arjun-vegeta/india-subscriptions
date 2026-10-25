package dev.indiasubscriptions

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

/** Opens the hosted checkout page. The default is [CustomTabsPageOpener]; replace it to use another browser surface or to fake it in tests. */
public fun interface HostedPageOpener {
    /**
     * Opens [url]. [activity] is the activity the purchase was started from when it is still alive, otherwise null.
     * Throws when the page cannot be opened.
     */
    public fun open(activity: Activity?, url: String)
}

/**
 * Opens the page in a Custom Tab. With a live activity the tab opens over it; without one the application context is
 * used with `FLAG_ACTIVITY_NEW_TASK`. Only `https` addresses (and `http` when [allowCleartext] is set, for local
 * development) are opened. With no Custom Tabs provider installed the intent opens the default browser.
 */
public class CustomTabsPageOpener(
    private val applicationContext: Context,
    private val allowCleartext: Boolean = false,
) : HostedPageOpener {
    override fun open(activity: Activity?, url: String) {
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase()
        require(scheme == "https" || (allowCleartext && scheme == "http")) { "The hosted checkout address must be https" }
        val intent = CustomTabsIntent.Builder().build().apply {
            if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            intent.launchUrl(activity ?: applicationContext, uri)
        } catch (error: ActivityNotFoundException) {
            throw IllegalStateException("No browser can open the hosted checkout page", error)
        }
    }
}
