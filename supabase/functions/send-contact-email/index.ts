import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ContactEmailRequest {
  firstName: string;
  lastName?: string;
  email: string;
  phone?: string;
  message?: string;
  style?: string;
  source?: string;
}

const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PHONE_PATTERN = /^[0-9+().\- ]{3,32}$/;

const MAX_LENGTHS: Record<keyof ContactEmailRequest, number> = {
  firstName: 100,
  lastName: 100,
  email: 254,
  phone: 32,
  message: 5000,
  style: 200,
  source: 50,
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const stripControlChars = (value: string): string =>
  Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  }).join("");

const badRequest = (error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return badRequest("Invalid request body");
    }

    for (const [field, max] of Object.entries(MAX_LENGTHS)) {
      const value = (body as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || value.length > max) {
        return badRequest("Invalid request body");
      }
    }

    const {
      firstName,
      lastName = "",
      email: rawEmail,
      phone: rawPhone,
      message = "",
      style,
      source,
    } = body as ContactEmailRequest;

    // Validate required fields. Style Book inquiries don't require lastName or message.
    const isStyleBook = source === "style-book";
    if (!firstName || !rawEmail || (!isStyleBook && (!lastName || !message))) {
      return badRequest("Missing required fields");
    }

    const email = rawEmail.trim();
    if (!EMAIL_PATTERN.test(email)) {
      return badRequest("Invalid email address");
    }

    const phone = rawPhone?.trim();
    if (phone && !PHONE_PATTERN.test(phone)) {
      return badRequest("Invalid phone number");
    }

    const fullName = `${firstName}${lastName ? " " + lastName : ""}`.trim();
    const subjectName = stripControlChars(fullName);
    const subjectStyle = style ? stripControlChars(style) : "Unspecified";

    const safeFirstName = escapeHtml(firstName);
    const safeFullName = escapeHtml(fullName);
    const safeEmail = escapeHtml(email);
    const safePhone = phone ? escapeHtml(phone) : "";
    const telHref = phone ? phone.replace(/[^0-9+]/g, "") : "";
    const safeMessage = escapeHtml(message);
    const safeStyle = style ? escapeHtml(style) : "";

    console.log("Sending contact form email for:", fullName, email, "source:", source);

    // Send notification email to the team
    const teamEmailResponse = await resend.emails.send({
      from: "Beau Monde Builders <onboarding@resend.dev>",
      to: ["ajhoover@mac.com"],
      subject: isStyleBook
        ? `Style Book Inquiry — ${subjectStyle} — ${subjectName}`
        : `New Contact Form Submission from ${subjectName}`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #B8860B; font-weight: 300; font-size: 28px; margin-bottom: 30px;">${isStyleBook ? "Style Book Inquiry" : "New Contact Form Submission"}</h1>

          ${isStyleBook && style ? `
          <div style="background: #f4efe4; padding: 24px 30px; margin-bottom: 20px; border-left: 3px solid #B8860B;">
            <p style="margin: 0; color: #555; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;">Style of Interest</p>
            <p style="margin: 8px 0 0; color: #0f2a3d; font-size: 22px;">${safeStyle}</p>
          </div>` : ""}

          <div style="background: #f9f9f9; padding: 30px; margin-bottom: 30px;">
            <h2 style="color: #333; font-size: 18px; margin-bottom: 20px;">Contact Details</h2>
            <p style="margin: 10px 0; color: #555;"><strong>Name:</strong> ${safeFullName}</p>
            <p style="margin: 10px 0; color: #555;"><strong>Email:</strong> <a href="mailto:${safeEmail}" style="color: #B8860B;">${safeEmail}</a></p>
            ${phone ? `<p style="margin: 10px 0; color: #555;"><strong>Phone:</strong> <a href="tel:${telHref}" style="color: #B8860B;">${safePhone}</a></p>` : ''}
          </div>

          ${message ? `<div style="background: #f9f9f9; padding: 30px;">
            <h2 style="color: #333; font-size: 18px; margin-bottom: 20px;">Message</h2>
            <p style="color: #555; line-height: 1.6; white-space: pre-wrap;">${safeMessage}</p>
          </div>` : ""}

          <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
            This email was sent from the Beau Monde Builders ${isStyleBook ? "Style Book" : "contact form"}.
          </p>
        </div>
      `,
    });

    console.log("Team notification email sent:", teamEmailResponse);

    // Send confirmation email to the user
    const userEmailResponse = await resend.emails.send({
      from: "Beau Monde Builders <onboarding@resend.dev>",
      to: [email],
      subject: isStyleBook
        ? "Thank You — Your Style Book Inquiry"
        : "Thank You for Contacting Beau Monde Builders",
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #B8860B; font-weight: 300; font-size: 28px; margin-bottom: 30px;">Thank You, ${safeFirstName}</h1>

          <p style="color: #555; line-height: 1.8; font-size: 16px;">
            ${isStyleBook && style
              ? `We've noted your interest in <strong>${safeStyle}</strong> and appreciate you reaching out to Beau Monde Builders.`
              : "We have received your message and appreciate you reaching out to Beau Monde Builders."}
          </p>

          <p style="color: #555; line-height: 1.8; font-size: 16px;">
            Our team will review your inquiry and respond within 24 hours to schedule your private consultation.
          </p>
          
          <div style="margin-top: 40px; padding-top: 30px; border-top: 1px solid #eee;">
            <p style="color: #333; font-weight: 500; margin-bottom: 10px;">Beau Monde Builders Space Coast</p>
            <p style="color: #777; font-size: 14px; margin: 5px 0;">1129 Rockledge Boulevard</p>
            <p style="color: #777; font-size: 14px; margin: 5px 0;">Rockledge, FL 32955</p>
            <p style="color: #777; font-size: 14px; margin: 5px 0;">(321) 298-4122</p>
          </div>
        </div>
      `,
    });

    console.log("User confirmation email sent:", userEmailResponse);

    return new Response(
      JSON.stringify({ success: true, message: "Emails sent successfully" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  } catch (error: unknown) {
    console.error("Error in send-contact-email function:", error);
    return new Response(
      JSON.stringify({ error: "Unable to send message" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
