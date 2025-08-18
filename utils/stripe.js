import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Stripe from environment variable, fallback to test key for local
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_51RtqCK85UAqQraHRPjXclqzjvyako5MOowBKCIfdMlsA0YPOGSwhWDWrrcqRxaoETmDJdBhr78Z7ZYy0IoVMVMtc002sGJ5W8a', {
  apiVersion: '2024-06-20',
});

export const createPaymentIntent = async (amount, currency = 'inr', metadata = {}) => {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to smallest currency unit (paise for INR)
      currency: currency,
      metadata: metadata,
      automatic_payment_methods: {
        enabled: true,
      },
    });
    
    return {
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    };
  } catch (error) {
    console.error('Error creating payment intent:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

export const confirmPayment = async (paymentIntentId) => {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status === 'succeeded') {
      return {
        success: true,
        paymentIntent: paymentIntent,
        transactionId: paymentIntent.id,
      };
    } else {
      return {
        success: false,
        error: `Payment status: ${paymentIntent.status}`,
      };
    }
  } catch (error) {
    console.error('Error confirming payment:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

// Create a SetupIntent to collect and save a payment method for future use
export const createSetupIntent = async (customerId = null, paymentMethodTypes = ['card']) => {
  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId || undefined,
      payment_method_types: paymentMethodTypes,
      usage: 'off_session'
    });
    return {
      success: true,
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
    };
  } catch (error) {
    console.error('Error creating setup intent:', error);
    return { success: false, error: error.message };
  }
};

export const createCustomer = async (email, name) => {
  try {
    const customer = await stripe.customers.create({
      email: email,
      name: name,
    });
    
    return {
      success: true,
      customerId: customer.id,
    };
  } catch (error) {
    console.error('Error creating customer:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

export const createPaymentMethod = async (type, cardDetails) => {
  try {
    let paymentMethodData = {};
    
    if (type === 'card') {
      paymentMethodData = {
        type: 'card',
        card: {
          number: cardDetails.number,
          exp_month: parseInt(cardDetails.expiry.split('/')[0]),
          exp_year: parseInt('20' + cardDetails.expiry.split('/')[1]),
          cvc: cardDetails.cvc,
        },
      };
    }
    
    const paymentMethod = await stripe.paymentMethods.create(paymentMethodData);
    
    return {
      success: true,
      paymentMethodId: paymentMethod.id,
      last4: paymentMethod.card?.last4,
    };
  } catch (error) {
    console.error('Error creating payment method:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

export const attachPaymentMethodToCustomer = async (customerId, paymentMethodId) => {
  try {
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });
    
    return {
      success: true,
    };
  } catch (error) {
    console.error('Error attaching payment method:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

export const refundPayment = async (paymentIntentId, amount = null) => {
  try {
    const refundData = {
      payment_intent: paymentIntentId,
    };
    
    if (amount) {
      refundData.amount = Math.round(amount * 100);
    }
    
    const refund = await stripe.refunds.create(refundData);
    
    return {
      success: true,
      refundId: refund.id,
      status: refund.status,
    };
  } catch (error) {
    console.error('Error creating refund:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

export default stripe;
