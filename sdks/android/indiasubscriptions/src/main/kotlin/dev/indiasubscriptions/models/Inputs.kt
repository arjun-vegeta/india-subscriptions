package dev.indiasubscriptions.models

import org.json.JSONObject

/** A customer: identity and contact details. */
public data class Customer(
    val id: String? = null,
    val name: String? = null,
    val email: String? = null,
    /** Mobile number; 10 digits or E.164. */
    val phone: String? = null,
    /** The customer's state or union territory in India (for example "Karnataka"). Needed for user choice billing. */
    val state: String? = null,
) {
    internal fun toJson(): JSONObject = JSONObject().apply {
        id?.let { put("id", it) }
        name?.let { put("name", it) }
        email?.let { put("email", it) }
        phone?.let { put("phone", it) }
        state?.let { put("state", it) }
    }
}

/** The body of the start call. */
public data class StartPurchaseInput(
    val platform: Platform = Platform.Android,
    /** The key of the product. */
    val product: String,
    val customer: Customer = Customer(),
    /** Your id for the customer: entitlements are kept under it. */
    val customerRef: String,
    /**
     * Your own id for the purchase: at most 25 characters of letters, digits, `_` and `-`. Starting again with the same
     * reference and customer returns the same session.
     */
    val reference: String? = null,
    /** Where the hosted checkout sends the customer when it is done: your app's return link. */
    val returnUrl: String? = null,
) {
    internal fun toJson(): JSONObject = JSONObject().apply {
        put("platform", platform.value)
        put("product", product)
        put("customer", customer.toJson())
        put("customerRef", customerRef)
        reference?.let { put("reference", it) }
        returnUrl?.let { put("returnUrl", it) }
    }
}

/** The body of the alternative call (Google Play user choice billing). */
public data class ChooseAlternativeInput(val externalTransactionToken: String) {
    internal fun toJson(): JSONObject = JSONObject().put("externalTransactionToken", externalTransactionToken)
}

/** The body of the complete call: what the provider handed back to the device, untouched. */
public data class CompletePurchaseInput(val provider: Provider, val result: Map<String, String>) {
    internal fun toJson(): JSONObject = JSONObject().apply {
        put("provider", provider.value)
        put("result", JSONObject(result))
    }

    public companion object {
        /** The Google Play form: `{ "purchaseToken", "productId" }`. The server acknowledges or consumes the purchase. */
        public fun googlePlay(purchaseToken: String, productId: String): CompletePurchaseInput = CompletePurchaseInput(
            Provider.GooglePlay,
            mapOf("purchaseToken" to purchaseToken, "productId" to productId),
        )
    }
}
