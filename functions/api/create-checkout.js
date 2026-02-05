export async function onRequestPost(context) {
    const { request, env } = context;

    // CORS headers
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    try {
        const { amount, type } = await request.json();

        // Validate input
        if (!amount || amount < 1) {
            return new Response(
                JSON.stringify({ error: 'Invalid amount' }),
                { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
        }

        if (!['monthly', 'one-time'].includes(type)) {
            return new Response(
                JSON.stringify({ error: 'Invalid donation type' }),
                { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
        }

        const stripeSecretKey = env.STRIPE_SECRET_KEY;
        if (!stripeSecretKey) {
            console.error('STRIPE_SECRET_KEY not configured');
            return new Response(
                JSON.stringify({ error: 'Payment system not configured' }),
                { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
        }

        const baseUrl = new URL(request.url).origin;

        let sessionData;

        if (type === 'monthly') {
            // Create a subscription checkout session
            sessionData = {
                mode: 'subscription',
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Monthly Donation to Shaarei Avodah',
                            description: 'Thank you for your ongoing support!',
                        },
                        unit_amount: amount * 100, // Convert to cents
                        recurring: {
                            interval: 'month',
                        },
                    },
                    quantity: 1,
                }],
                success_url: `${baseUrl}/donate-success.html?type=monthly`,
                cancel_url: `${baseUrl}/donate.html`,
            };
        } else {
            // Create a one-time payment checkout session
            sessionData = {
                mode: 'payment',
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'One-Time Donation to Shaarei Avodah',
                            description: 'Thank you for your generous support!',
                        },
                        unit_amount: amount * 100, // Convert to cents
                    },
                    quantity: 1,
                }],
                success_url: `${baseUrl}/donate-success.html?type=one-time`,
                cancel_url: `${baseUrl}/donate.html`,
            };
        }

        // Create Stripe Checkout Session using fetch
        const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${stripeSecretKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: encodeStripeData(sessionData),
        });

        const session = await stripeResponse.json();

        if (session.error) {
            console.error('Stripe error:', session.error);
            return new Response(
                JSON.stringify({ error: session.error.message || 'Failed to create checkout session' }),
                { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
        }

        return new Response(
            JSON.stringify({ url: session.url }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );

    } catch (error) {
        console.error('Error:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
    }
}

// Handle CORS preflight
export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}

// Helper function to encode data for Stripe API (x-www-form-urlencoded format)
function encodeStripeData(data, prefix = '') {
    const params = new URLSearchParams();

    function encode(obj, currentPrefix) {
        for (const [key, value] of Object.entries(obj)) {
            const paramKey = currentPrefix ? `${currentPrefix}[${key}]` : key;

            if (Array.isArray(value)) {
                value.forEach((item, index) => {
                    if (typeof item === 'object' && item !== null) {
                        encode(item, `${paramKey}[${index}]`);
                    } else {
                        params.append(`${paramKey}[${index}]`, item);
                    }
                });
            } else if (typeof value === 'object' && value !== null) {
                encode(value, paramKey);
            } else {
                params.append(paramKey, value);
            }
        }
    }

    encode(data, prefix);
    return params.toString();
}
