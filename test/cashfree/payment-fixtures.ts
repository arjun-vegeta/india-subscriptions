/**
 * Fixtures for the one-time payment tests: the sample payloads of Cashfree's documentation (https://www.cashfree.com/docs/),
 * each with the page it comes from. Webhook bodies are the printed text, byte for byte, because the signature covers the
 * exact bytes. The API response samples are published as YAML in the OpenAPI document embedded in each page; they are
 * written here as the same values in JSON. Nothing in this file is hand-edited except where a comment says so.
 */

/** api-reference/payments/latest/orders/create, response 200, example `create_order_success`. */
export const CREATE_ORDER_RESPONSE = {
  "cf_order_id": "2149460581",
  "created_at": "2023-08-11T18:02:46+05:30",
  "customer_details": {
    "customer_id": "409128494",
    "customer_name": "John Doe",
    "customer_email": "pmlpayme@ntsas.com",
    "customer_phone": "9876543210",
    "customer_uid": "54deabb4-ba45-4a60-9e6a-9c016fe7ab10"
  },
  "entity": "order",
  "order_amount": 22,
  "payment_session_id": "session_a1VXIPJo8kh7IBigVXX8LgTMupQW_cu25FS8KwLwQLOmiHqbBxq5UhEilrhbDSKKHA6UAuOj9506aaHNlFAHEqYrHSEl9AVtYQN9LIIc4vkH",
  "order_currency": "INR",
  "order_expiry_time": "2023-09-09T18:02:46+05:30",
  "order_id": "order_3242Tq4Edj9CC5RDcMeobmJOWOBJij",
  "order_meta": {
    "return_url": "https://www.cashfree.com/devstudio/thankyou",
    "payment_methods": "cc",
    "notify_url": "https://example.com/cf_notify"
  },
  "order_note": "Order created for payment",
  "order_splits": [],
  "order_status": "ACTIVE",
  "order_tags": {
    "name": "John",
    "age": "19"
  },
  "terminal_data": null,
  "cart_details": {
    "cart_id": "1"
  }
};

/** api-reference/payments/latest/orders/get, response 200, example `get_order_active`. */
export const GET_ORDER_ACTIVE = {
  "cf_order_id": "2149460581",
  "created_at": "2023-08-11T18:02:46+05:30",
  "customer_details": {
    "customer_id": "409128494",
    "customer_name": "John Doe",
    "customer_email": "pmlpayme@ntsas.com",
    "customer_phone": "9876543210",
    "customer_uid": "54deabb4-ba45-4a60-9e6a-9c016fe7ab10"
  },
  "entity": "order",
  "order_amount": 22,
  "payment_session_id": "session_a1VXIPJo8kh7IBigVXX8LgTMupQW_cu25FS8KwLwQLOmiHqbBxq5UhEilrhbDSKKHA6UAuOj9506aaHNlFAHEqYrHSEl9AVtYQN9LIIc4vkH",
  "order_currency": "INR",
  "order_expiry_time": "2023-09-09T18:02:46+05:30",
  "order_id": "order_3242Tq4Edj9CC5RDcMeobmJOWOBJij",
  "order_meta": {
    "return_url": "https://www.cashfree.com/devstudio/thankyou",
    "payment_methods": "cc",
    "notify_url": "https://example.com/cf_notify"
  },
  "order_note": "Order created for payment",
  "order_splits": [],
  "order_status": "ACTIVE",
  "order_tags": {
    "name": "John",
    "age": "19"
  },
  "terminal_data": null,
  "cart_details": {
    "cart_id": "1"
  }
};

/** api-reference/payments/latest/orders/get, response 200, example `get_order_paid`. */
export const GET_ORDER_PAID = {
  "cf_order_id": "2149460582",
  "created_at": "2023-08-10T14:30:20+05:30",
  "customer_details": {
    "customer_id": "409128495",
    "customer_name": "Jane Smith",
    "customer_email": "jane.smith@example.com",
    "customer_phone": "9876543211",
    "customer_uid": "64deabb4-ca45-4b60-9e6a-9c016fe7ab11"
  },
  "entity": "order",
  "order_amount": 150.5,
  "payment_session_id": "session_b2VXIPJo8kh7IBigVXX8LgTMupQW_cu25FS8KwLwQLOmiHqbBxq5UhEilrhbDSKKHA6UAuOj9506aaHNlFAHEqYrHSEl9AVtYQN9LIIc4vkH",
  "order_currency": "INR",
  "order_expiry_time": "2023-09-08T14:30:20+05:30",
  "order_id": "order_4353Ur5Fgk0DD6SEfNfpcnKPXPCKjk",
  "order_meta": {
    "return_url": "https://www.cashfree.com/devstudio/thankyou",
    "payment_methods": "upi,card,netbanking",
    "notify_url": "https://example.com/cf_notify"
  },
  "order_note": "Payment completed successfully",
  "order_splits": [],
  "order_status": "PAID",
  "order_tags": {
    "product": "Premium Plan",
    "category": "subscription"
  },
  "terminal_data": null,
  "cart_details": {
    "cart_id": "2"
  }
};

/** api-reference/payments/latest/payments/get-payments-for-order, example `payments_entity_list_example`: its first two entries (a successful UPI attempt and a failed card attempt of `order_8123`). The page's third entry belongs to another order. */
export const PAYMENTS_FOR_ORDER_UPI = [
  {
    "cf_payment_id": "12376123",
    "order_id": "order_8123",
    "entity": "payment",
    "payment_currency": "INR",
    "error_details": null,
    "order_amount": 10.01,
    "order_currency": "INR",
    "is_captured": true,
    "payment_group": "upi",
    "authorization": {
      "action": "CAPTURE",
      "status": "PENDING",
      "captured_amount": 100,
      "start_time": "2022-02-09T18:04:34+05:30",
      "end_time": "2022-02-19T18:04:34+05:30",
      "approve_by": "2022-02-09T18:04:34+05:30",
      "action_reference": "6595231908096894505959",
      "action_time": "2022-08-03T16:09:51"
    },
    "payment_method": {
      "upi": {
        "channel": "collect",
        "upi_id": "rohit@xcxcx",
        "upi_payer_ifsc": "AXL1234",
        "upi_payer_account_number": "XXXXXXX6024"
      }
    },
    "payment_amount": 10.01,
    "payment_time": "2021-07-23T12:15:06+05:30",
    "payment_completion_time": "2021-07-23T12:18:59+05:30",
    "payment_status": "SUCCESS",
    "payment_surcharge": {
      "payment_surcharge_service_charge": 0,
      "payment_surcharge_service_tax": 0
    },
    "payment_message": "Transaction successful",
    "bank_reference": "P78112898712",
    "auth_id": "A898101",
    "international_payment": {
      "international": false
    },
    "payment_gateway_details": {
      "gateway_name": "CASHFREE",
      "gateway_order_id": "1234421ABD",
      "gateway_payment_id": "XABDJ2213",
      "gateway_order_reference_id": "BDIWO233",
      "gateway_settlement": "cashfree",
      "gateway_reference_name": ""
    }
  },
  {
    "cf_payment_id": "12376124",
    "order_id": "order_8123",
    "entity": "payment",
    "payment_currency": "INR",
    "error_details": {
      "error_code": "TRANSACTION_DECLINED",
      "error_description": "issuer bank or payment service provider declined the transaction",
      "error_reason": "auth_declined",
      "error_source": "customer"
    },
    "order_amount": 10.01,
    "order_currency": "INR",
    "is_captured": true,
    "payment_group": "credit_card",
    "authorization": null,
    "payment_method": {
      "card": {
        "channel": "link",
        "card_number": "xxxxxx1111"
      }
    },
    "payment_amount": 10.01,
    "payment_time": "2021-07-23T12:15:06+05:30",
    "payment_completion_time": "2021-07-23T12:18:59+05:30",
    "payment_status": "FAILED",
    "payment_surcharge": {
      "payment_surcharge_service_charge": 0,
      "payment_surcharge_service_tax": 0
    },
    "payment_message": "Transaction failed",
    "bank_reference": "P78112898712",
    "auth_id": "A898101",
    "international_payment": {
      "international": false
    },
    "payment_gateway_details": {
      "gateway_name": "CASHFREE",
      "gateway_order_id": "1234421ABD",
      "gateway_payment_id": "XABDJ2213",
      "gateway_order_reference_id": "BDIWO233",
      "gateway_settlement": "cashfree",
      "gateway_reference_name": ""
    }
  }
];

/** api-reference/payments/latest/payments/get-payments-for-order, response 200, example `card`. */
export const PAYMENTS_FOR_ORDER_CARD = [
  {
    "auth_id": "749842",
    "authorization": null,
    "bank_reference": "519615460937",
    "cf_payment_id": "4128924251",
    "entity": "payment",
    "error_details": null,
    "international_payment": {
      "international": false
    },
    "is_captured": true,
    "order_amount": 1,
    "order_currency": "INR",
    "order_id": "order_18482zuD6LhQGYO3OOihGjnlDV4OzpD",
    "payment_amount": 1,
    "payment_completion_time": "2025-07-15T15:02:48+05:30",
    "payment_currency": "INR",
    "payment_gateway_details": {
      "gateway_name": "CASHFREE",
      "gateway_order_id": null,
      "gateway_payment_id": null,
      "gateway_order_reference_id": null,
      "gateway_status_code": null,
      "gateway_settlement": "cashfree",
      "gateway_reference_name": null
    },
    "payment_group": "debit_card",
    "payment_message": "Transaction Success",
    "payment_method": {
      "card": {
        "card_bank_name": "KOTAK MAHINDRA BANK",
        "card_country": "IN",
        "card_network": "visa",
        "card_network_reference_id": null,
        "card_number": "XXXXXXXXXXXX4738",
        "card_sub_type": "R",
        "card_type": "debit_card",
        "channel": "link"
      },
      "payment_offers": null,
      "payment_status": "SUCCESS",
      "payment_surcharge": {
        "payment_surcharge_service_charge": 0,
        "payment_surcharge_service_tax": 0
      },
      "payment_time": "2025-07-15T15:01:53+05:30"
    }
  },
  {
    "auth_id": null,
    "authorization": null,
    "bank_reference": null,
    "cf_payment_id": "4128923713",
    "entity": "payment",
    "error_details": {
      "error_code": "",
      "error_description": "",
      "error_reason": "",
      "error_source": "",
      "error_code_raw": "05",
      "error_description_raw": "AUTHENTICATION_FAILURE - (01 - Cardholder selected Cancel)",
      "error_subcode_raw": ""
    },
    "international_payment": {
      "international": false
    },
    "is_captured": false,
    "order_amount": 1,
    "order_currency": "INR",
    "order_id": "order_18482zuD6LhQGYO3OOihGjnlDV4OzpD",
    "payment_amount": 1,
    "payment_completion_time": "2025-07-15T15:01:49+05:30",
    "payment_currency": "INR",
    "payment_gateway_details": {
      "gateway_name": "CASHFREE",
      "gateway_order_id": null,
      "gateway_payment_id": null,
      "gateway_order_reference_id": null,
      "gateway_status_code": null,
      "gateway_settlement": "cashfree",
      "gateway_reference_name": null
    },
    "payment_group": "debit_card",
    "payment_message": "Transaction Failed -  (01 - Cardholder selected Cancel)",
    "payment_method": {
      "card": {
        "card_bank_name": "KOTAK MAHINDRA BANK",
        "card_country": "IN",
        "card_network": "visa",
        "card_network_reference_id": null,
        "card_number": "XXXXXXXXXXXX4738",
        "card_sub_type": "R",
        "card_type": "debit_card",
        "channel": "link"
      },
      "payment_offers": null,
      "payment_status": "FAILED",
      "payment_surcharge": {
        "payment_surcharge_service_charge": 0,
        "payment_surcharge_service_tax": 0
      },
      "payment_time": "2025-07-15T15:01:53+05:30"
    }
  }
];

/** api-reference/payments/latest/refunds/create-refund, response 200, example `refunds_entity_example` (also the shape of the refund list on api-reference/payments/latest/refunds/get-all-refunds-for-an-order). */
export const REFUND_ENTITY = {
  "cf_payment_id": "918812",
  "cf_refund_id": "1553338",
  "refund_id": "REF-123",
  "order_id": "c6G-QMcbm1848",
  "entity": "refund",
  "refund_amount": 100.81,
  "refund_currency": "INR",
  "refund_note": "Refund for order #123",
  "refund_status": "SUCCESS",
  "refund_type": "MERCHANT_INITIATED",
  "refund_splits": [],
  "status_description": "In Progress",
  "refund_arn": "RF12312",
  "metadata": null,
  "created_at": "2021-07-25T08:57:52+05:30",
  "processed_at": "2021-07-25T12:57:52+05:30",
  "refund_charge": 0,
  "refund_mode": "STANDARD",
  "forex_conversion_handling_charge": 11.12,
  "forex_conversion_handling_tax": 1.12,
  "forex_conversion_rate": 84.24,
  "charges_currency": "INR"
};

/** api-reference/payments/latest/payments/webhooks, "Payment success webhook", Version (2026-01-01). */
export const PAYMENT_SUCCESS_2026 = `{
"data": {
"order": {
  "order_id": "order_1112353JRZPMsx42lOnAuXiz0vddwovDk",
  "order_amount": 1,
  "order_currency": "INR",
  "order_tags": {
    "GST": "364JPAYTM0312",
    "Merchant_ID": "123456",
    "Merchant_Note": "99month Incl GST for 12 MonthsJPAYTMTJMMO_0003"
  },
  "order_note": "testing Terminate Order Flow"
},
"payment": {
  "cf_payment_id": "1453995084705707520",
  "payment_status": "SUCCESS",
  "payment_amount": 1,
  "payment_currency": "INR",
  "payment_message": "Simulated response message",
  "payment_time": "2026-09-17T11:47:22+05:30",
  "bank_reference": "1453995084705707520",
  "auth_id": null,
  "payment_method": {
    "netbanking": {
      "channel": null,
      "netbanking_bank_code": "3032",
      "netbanking_bank_name": "Kotak Mahindra Bank"
    }
  },
  "payment_group": "net_banking",
  "international_payment": null,
  "payment_surcharge": {
    "payment_surcharge_service_charge": 0,
    "payment_surcharge_service_tax": 0
  }
},
"customer_details": {
  "customer_name": "ABC co",
  "customer_id": "Customer_123",
  "customer_email": null,
  "customer_phone": "8971520300"
},
"payment_gateway_details": {
  "gateway_name": "CASHFREE",
  "gateway_order_id": "1453994974886245888",
  "gateway_payment_id": "1453995084705707520",
  "gateway_status_code": null,
  "gateway_order_reference_id": null,
  "gateway_settlement": "CASHFREE",
  "gateway_reference_name": null
},
"payment_offers": null,
"terminal_details": null
},
"event_time": "2026-09-17T11:47:29+05:30",
"type": "PAYMENT_SUCCESS_WEBHOOK"
}`;

/** api-reference/payments/latest/payments/webhooks, "Payment success webhook", Version (2025-01-01). */
export const PAYMENT_SUCCESS_2025 = `{
"data":{
  "order":{
     "order_id":"order_OFR_2",
     "order_amount":2,
     "order_currency":"INR",
     "order_tags":null
  },
  "payment":{
     "cf_payment_id":"1453002795",
     "payment_status":"SUCCESS",
     "payment_amount":1,
     "payment_currency":"INR",
     "payment_message":"00::Transaction success",
     "payment_time":"2025-01-15T12:20:29+05:30",
     "bank_reference":"234928698581",
     "auth_id":null,
     "payment_method":{
        "upi":{
           "channel":"collect",
           "upi_id":"rishab@ybl",
           "upi_instrument":"UPI_CREDIT_CARD",
           "upi_instrument_number":"masked card number",
           "upi_payer_ifsc":"SBI0025434",
           "upi_payer_account_number":"XXXXX0231"
        }
     },
     "payment_group":"upi",
     "international_payment":{
        "international":false
     },
     "payment_surcharge":{
        "payment_surcharge_service_charge":0.36,
        "payment_surcharge_service_tax":0.06
     }
  },
  "customer_details":{
     "customer_name":null,
     "customer_id":"7112AAA812234",
     "customer_email":"test@gmail.com",
     "customer_phone":"9908734801"
  },
  "payment_gateway_details":{
     "gateway_name":"CASHFREE",
     "gateway_order_id":"1634766330",
     "gateway_payment_id":"1504280029",
     "gateway_order_reference_id":"abc_124",
     "gateway_settlement":"CASHFREE",
     "gateway_status_code":null
  },
  "payment_offers":[
     {
        "offer_id":"0f05e1d0-fbf8-4c9c-a1f0-814c7b2abdba",
        "offer_type":"DISCOUNT",
        "offer_meta":{
           "offer_title":"50% off on UPI",
           "offer_description":"50% off for testing",
           "offer_code":"UPI50",
           "offer_start_time":"2022-11-09T06:23:25.972Z",
           "offer_end_time":"2025-02-27T18:30:00Z"
        },
        "offer_redemption":{
           "redemption_status":"SUCCESS",
           "discount_amount":1,
           "cashback_amount":0
        }
     }
  ],
  "terminal_details":{
    "cf_terminal_id":17269,
    "terminal_phone":"8971520311"
  }
},
"event_time":"2025-01-15T11:16:10+05:30",
"type":"PAYMENT_SUCCESS_WEBHOOK"
}`;

/** api-reference/payments/latest/payments/webhooks, "Payment failed webhook", Version 2026-01-01. */
export const PAYMENT_FAILED_2026 = `{  
"data": {  
    "order": {  
        "order_id": "CFPay_g47u3888d0k0_tblfm766qc",  
        "order_amount": 1.8,  
        "order_currency": "INR",  
        "order_tags": {  
            "cf_link_id": "13746255",
            "link_id": "7f0efd36-23f3-4213-95dc-3c32ba1a27e2"
        },
        "order_note": "Sample Order Note"
    },  
    "payment": {  
        "cf_payment_id": "1504280029",  
        "payment_status": "FAILED",  
        "payment_amount": 1.8,  
        "payment_currency": "INR",  
        "payment_message": "AMOUNT SHOULD BE WITHIN RANGE BETWEEN 20.00 TO 500000.00.",  
        "payment_time": "2023-01-06T20:00:11+05:30",  
        "bank_reference": "NA",  
        "auth_id": "null",  
        "payment_method": {  
            "netbanking": {  
                "channel": null,  
                "netbanking_bank_code": "3054",  
                "netbanking_bank_name": "UCO Bank"  
            }  
        },  
        "payment_group": "net_banking",
        "international_payment":{
            "international":false
        },
        "payment_surcharge":{
            "payment_surcharge_service_charge":0,
            "payment_surcharge_service_tax":0
        }
    },  
    "customer_details": {  
        "customer_name": null,  
        "customer_id": null,  
        "customer_email": "test@gmail.com",  
        "customer_phone": "9611199227"  
    },  
    "error_details": {  
        "error_code": "GATEWAY_ERROR",  
        "error_description": "AMOUNT SHOULD BE WITHIN RANGE BETWEEN 20.00 TO 500000.00. for this bank",  
        "error_reason": "invalid_amount",  
        "error_source": "cashfree",
        "error_code_raw": null,
        "error_description_raw": null,
        "error_subcode_raw": "U09"
    },  
    "payment_gateway_details": {
        "gateway_name": "CASHFREE",
        "gateway_order_id": "1634766330",
        "gateway_payment_id": "1504280029",
        "gateway_settlement": "CASHFREE",
        "gateway_order_reference_id": null,
        "gateway_reference_name": null,
        "gateway_status_code": null
    }, 
    "payment_offers": null,
    "terminal_details":{
        "cf_terminal_id":17269,
        "terminal_phone":"8971520311"
    }
},  
"event_time": "2023-08-01T20:00:12+05:30",  
"type": "PAYMENT_FAILED_WEBHOOK"  
}`;

/** api-reference/payments/latest/payments/webhooks, "Payment user dropped webhook", Version 2026-01-01. */
export const PAYMENT_USER_DROPPED_2026 = `{
"data": {
"order": {
  "order_id": "order_02",
  "order_amount": 2,
  "order_currency": "INR",
  "order_tags": null,
  "order_note": "Sample Order Note"
},
"payment": {
  "cf_payment_id": "975672265",
  "payment_status": "USER_DROPPED",
  "payment_amount": 2,
  "payment_currency": "INR",
  "payment_message": "User dropped and did not complete the two factor authentication",
  "payment_time": "2022-05-25T14:25:34+05:30",
  "bank_reference": "1803592531",
  "auth_id": "2980",
  "payment_method": {
    "netbanking": {
      "channel": null,
      "netbanking_bank_code": "3044",
      "netbanking_bank_name": "State Bank Of India"
    }
  },
  "payment_group": "net_banking",
  "international_payment":{
    "international":false
  },
  "payment_surcharge":{
    "payment_surcharge_service_charge":0,
    "payment_surcharge_service_tax":0
  }
},
"customer_details": {
  "customer_name": null,
  "customer_id": "7112AAA812234",
  "customer_email": "test@gmail.com",
  "customer_phone": "9611199227"
},
"terminal_details":{
  "cf_terminal_id":17269,
  "terminal_phone":"8971520311"
}
},
"event_time": "2022-05-25T14:35:38+05:30",
"type": "PAYMENT_USER_DROPPED_WEBHOOK"
}`;

/** api-reference/payments/latest/payments/webhooks, "Payment charges webhook", Version 2026-01-01. */
export const PAYMENT_CHARGES_2026 = `{
"data": {
"order": {
  "order_id": "14508_73_1783668483731",
  "order_amount": 6.00,
  "order_currency": "INR",
  "order_tags": null
},
"payment": {
  "cf_payment_id": 5979305158,
  "payment_status": "SUCCESS",
  "payment_amount": 6.00,
  "payment_currency": "INR",
  "payment_message": "SUCCESS",
  "payment_time": "2026-07-10T12:58:04+05:30",
  "bank_reference": "841754751916",
  "auth_id": null,
  "payment_method": {},
  "payment_group": "sbc_upi"
},
"customer_details": {
  "customer_name": null,
  "customer_id": null,
  "customer_email": "rfeef@gmail.com",
  "customer_phone": "9876543211"
},
"charges_details": {
  "service_charge": 0.12,
  "service_tax": 0.02,
  "settlement_amount": 5.86,
  "settlement_currency": "INR",
  "service_charge_discount": null
}
},
"event_time": "2026-07-15T08:00:05+05:30",
"type": "PAYMENT_CHARGES_WEBHOOK"
}`;

/** api-reference/payments/latest/refunds/webhooks, "Refund webhook payload", Version 2023-08-01. */
export const REFUND_STATUS_2023 = `{
"data":{
    "refund":{
         "cf_refund_id":11325632,
         "cf_payment_id":789727431,
         "refund_id":"refund_sampleorder0413",
         "order_id":"sampleorder0413",
         "refund_amount":2.00,
         "refund_currency":"INR",
         "entity":"Refund",
         "refund_type":"MERCHANT_INITIATED",
         "refund_arn":"205907014017",
         "refund_status":"SUCCESS",
         "status_description":"Refund processed successfully",
         "created_at":"2022-02-28T12:54:25+05:30",
         "processed_at":"2022-02-28T13:04:27+05:30",
         "refund_note":"Test",
         "refund_splits":[
            {
               "merchantVendorId":"sampleID12345",
               "amount":1,
               "percentage":null
            },
            {
               "merchantVendorId":"otherVendor",
               "amount":1,
               "percentage":null
            }
         ],
         "metadata":null,
         "requested_speed":"STANDARD",
         "processed_speed":"STANDARD",
         "service_charge":0.00,
         "service_tax":0.00
    }
   },
   "event_time":"2022-02-28T13:04:28+05:30",
   "type":"REFUND_STATUS_WEBHOOK"
}`;

/** api-reference/payments/latest/refunds/webhooks, "Refund webhook payload", Version 2025-01-01. As printed, the sample has an unquoted key (`terminalDetails:`) and is not valid JSON. */
export const REFUND_STATUS_2025 = `{
"data":{
    "refund":{
         "cf_refund_id":11325632,
         "cf_payment_id":789727431,
         "refund_id":"refund_sampleorder0413",
         "order_id":"sampleorder0413",
         "refund_amount":2.00,
         "refund_currency":"INR",
         "entity":"Refund",
         "refund_type":"MERCHANT_INITIATED",
         "refund_arn":"205907014017",
         "refund_status":"SUCCESS",
         "status_description":"Refund processed successfully",
         "created_at":"2022-02-28T12:54:25+05:30",
         "processed_at":"2022-02-28T13:04:27+05:30",
         "refund_note":"Test",
         "refund_splits":[
            {
               "merchantVendorId":"sampleID12345",
               "amount":1,
               "percentage":null
            },
            {
               "merchantVendorId":"otherVendor",
               "amount":1,
               "percentage":null
            }
         ],
         "metadata":null,
         "requested_speed":"STANDARD",
         "processed_speed":"STANDARD",
         "service_charge":0.00,
         "service_tax":0.00,
         "forex_conversion_handling_charge":null,
         "forex_conversion_handling_tax":null,
         "forex_conversion_rate":null,
         "charges_currency":null
      },
      terminalDetails:{
         "cf_terminal_id":17269,
         "terminal_phone":"8971520311"
      }
   },
   "event_time":"2022-02-28T13:04:28+05:30",
   "type":"REFUND_STATUS_WEBHOOK"
}`;

/** api-reference/payments/latest/refunds/webhooks, "Auto refund webhook payload", Version 2023-08-01. */
export const AUTO_REFUND_2023 = `{
  "data": {
    "auto_refund": {
      "event": "AUTO-REFUND",
      "cf_refund_id": 1243460973,
      "cf_payment_id": "2148333968",
      "bank_reference": "234928698581",
      "order_id": "order_1944392Tpba8y2fHcHVx0SwREojp51Jgr",
      "refund_amount": 39,
      "refund_currency": "INR",
      "refund_type": "PAYMENT_AUTO_REFUND",
      "refund_arn": "205907014017",
      "refund_status": "SUCCESS",
      "status_description": "Auto-Refund processed successfully",
      "refund_reason": "Multiple payments were performed against same order.",
      "created_at": "2023-08-11T14:08:28+05:30",
      "processed_at": null,
      "refund_charge": 0,
      "refund_splits": null,
      "metadata": null
    }
  },
  "event_time": "2023-08-11T14:10:21+05:30",
  "type": "AUTO_REFUND_STATUS_WEBHOOK"
}`;

/** api-reference/payments/latest/subscription/webhooks, "SUBSCRIPTION_PAYMENT_SUCCESS", Version (2026-01-01): a subscription webhook, to show it stays a subscription event. */
export const SUBSCRIPTION_PAYMENT_SUCCESS_2026 = `{
"data": {
"payment_id": "ab-SUBV2ODRc5Dl2meCr7Iui-1",
"cf_payment_id": "49914526",
"cf_txn_id": "4212435861",
"cf_order_id": "4518936510",
"subscription_id": "moznV33AssPd6vXsSm2",
"cf_subscription_id": "23601811",
"payment_type": "AUTH",
"subscription_details": {
  "cf_subscription_id": "23601811",
  "subscription_id": "moznV33AssPd6vXsSm2",
  "subscription_status": "ACTIVE",
  "subscription_expiry_time": "2047-07-30T13:24:54",
  "subscription_first_charge_time": null,
  "subscription_tags": {
    "company": "Cashfree",
    "name": "Payment link"
  },
  "next_schedule_date": null
},
"authorization_details": {
  "authorization_amount": 2.00,
  "authorization_amount_refund": false,
  "approve_by_time": "",
  "authorization_reference": "427b608f83ad4cbdb6d472xxxxx[at]xxxx",
  "authorization_time": "2025-08-07T05:53:22+05:30",
  "authorization_status": "ACTIVE",
  "payment_id": "ab-SUBV2ODRc5Dl2meCr7Iui-1",
  "payment_method": {
    "upi": {
      "channel": "link",
      "upi_id": "8100000000@ybl",
      "upi_instrument": "",
      "upi_instrument_number": "",
      "upi_payer_account_number": "",
      "upi_payer_ifsc": ""
    }
  },
  "payment_group": "upi"
},
"payment_amount": 2.00,
"payment_currency": "INR",
"payment_schedule_date": "",
"payment_initiated_date": "2025-08-07T05:52:21+05:30",
"payment_remarks": "auth payment",
"retry_attempts": 0,
"failure_details": {
  "failure_reason": null
},
"payment_status": "SUCCESS",
"payment_gateway_details": {
  "gateway_name": "CASHFREE",
  "gateway_subscription_id": "23601811",
  "gateway_payment_id": "49914526"
}
},
"event_time": "2025-08-07T05:53:21+05:30",
"type": "SUBSCRIPTION_PAYMENT_SUCCESS"
}
`;

/** api-reference/payments/latest/subscription/webhooks, "SUBSCRIPTION_REFUND_STATUS", Version (2025-01-01). */
export const SUBSCRIPTION_REFUND_STATUS_2025 = `{
"data": {
"payment_id": "yCzJxeT2aXDqI",
"cf_payment_id": "49778199",
"refund_id": "WHOqiwy05P1l0",
"cf_refund_id": "SUB_21ebb4bf-e84f-4afa-bb09-07aac433abe4",
"refund_amount": 1000.00,
"refund_speed": "STANDARD",
"refund_note": "Tesg Refund",
"refund_status": "SUCCESS",
"failure_details": "",
"refund_gateway_details": {
  "gateway_name": "CASHFREE",
  "gateway_payment_id": "49778199",
  "gateway_refund_id": "SUB_21ebb4bf-e84f-4afa-bb09-07aac433abe4"
}
},
"event_time": "2025-08-06T17:20:02+05:30",
"type": "SUBSCRIPTION_REFUND_STATUS"
}`;
