package dev.indiasubscriptions.backend

import dev.indiasubscriptions.models.ChooseAlternativeInput
import dev.indiasubscriptions.models.CompletePurchaseInput
import dev.indiasubscriptions.models.Entitlements
import dev.indiasubscriptions.models.PurchaseSession
import dev.indiasubscriptions.models.StartPurchaseInput

/**
 * The five calls the SDK makes to the merchant's backend, which forwards them to the service. The app never holds the
 * service's API key: the backend authenticates the user and calls the service.
 *
 * [HttpPurchaseBackend] is the ready-made implementation. Implement the interface yourself to reach the backend through
 * another transport, or to fake it in tests. Implementations throw [PurchaseBackendException]; any other exception
 * (except cancellation) is treated as a failure that may succeed later.
 */
public interface PurchaseBackend {
    /** `POST /v1/purchases`: starts a session for a product key. */
    public suspend fun startPurchase(input: StartPurchaseInput): PurchaseSession

    /** `GET /v1/purchases/{sessionId}`. */
    public suspend fun purchase(sessionId: String): PurchaseSession

    /** `POST /v1/purchases/{sessionId}/alternative`: hands over the external transaction token of user choice billing. */
    public suspend fun chooseAlternative(sessionId: String, input: ChooseAlternativeInput): PurchaseSession

    /** `POST /v1/purchases/{sessionId}/complete`: hands the provider's result to the server, which verifies it. */
    public suspend fun completePurchase(sessionId: String, input: CompletePurchaseInput): PurchaseSession

    /** `GET /v1/entitlements/{customerRef}`: what the customer owns. */
    public suspend fun entitlements(customerRef: String): Entitlements
}
