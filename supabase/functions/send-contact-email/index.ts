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

// The email and phone are placed in mailto:/tel: links in the team
// notification, so accept only a single bare address / phone number.
const EMAIL_PATTERN =
  /^[A-Za-z0-9._'+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const PHONE_PATTERN = /^\+?[0-9 ().-]+$/;

const isPlainEmail = (value: string): boolean =>
  value.length <= 254 && EMAIL_PATTERN.test(value);

const isPlainPhone = (value: string): boolean => {
  if (value.length > 40 || !PHONE_PATTERN.test(value)) return false;
  const digits = value.replace(/[^0-9]/g, "").length;
  return digits >= 7 && digits <= 15;
};

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

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
    const {
      firstName: rawFirstName,
      lastName: rawLastName = "",
      email: rawEmail,
      phone: rawPhone,
      message: rawMessage = "",
      style: rawStyle,
      source,
    }: ContactEmailRequest = await req.json();

    // Validate required fields. Style Book inquiries don't require lastName or message.
    const isStyleBook = source === "style-book";
    if (!rawFirstName || !rawEmail || (!isStyleBook && (!rawLastName || !rawMessage))) {
      return badRequest("Missing required fields");
    }

    const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
    if (!isPlainEmail(email)) {
      return badRequest("email must be a single plain email address");
    }
    const phone = typeof rawPhone === "string" ? rawPhone.trim() : "";
    if (rawPhone != null && rawPhone !== "" && !isPlainPhone(phone)) {
      return badRequest("phone must contain only digits and standard separators");
    }

    const firstName = escapeHtml(rawFirstName);
    const lastName = escapeHtml(rawLastName);
    const message = escapeHtml(rawMessage);
    const style = rawStyle ? escapeHtml(rawStyle) : undefined;

    const fullName = `${firstName}${lastName ? " " + lastName : ""}`.trim();
    const subjectName = `${rawFirstName}${rawLastName ? " " + rawLastName : ""}`.trim();
    console.log("Sending contact form email for:", subjectName, email, "source:", source);

    // Send notification email to the team
    const teamEmailResponse = await resend.emails.send({
      from: "Beau Monde Builders <onboarding@resend.dev>",
      to: ["ajhoover@mac.com"],
      subject: isStyleBook
        ? `Style Book Inquiry — ${rawStyle ?? "Unspecified"} — ${subjectName}`
        : `New Contact Form Submission from ${subjectName}`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #B8860B; font-weight: 300; font-size: 28px; margin-bottom: 30px;">${isStyleBook ? "Style Book Inquiry" : "New Contact Form Submission"}</h1>

          ${isStyleBook && style ? `
          <div style="background: #f4efe4; padding: 24px 30px; margin-bottom: 20px; border-left: 3px solid #B8860B;">
            <p style="margin: 0; color: #555; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;">Style of Interest</p>
            <p style="margin: 8px 0 0; color: #0f2a3d; font-size: 22px;">${style}</p>
          </div>` : ""}

          <div style="background: #f9f9f9; padding: 30px; margin-bottom: 30px;">
            <h2 style="color: #333; font-size: 18px; margin-bottom: 20px;">Contact Details</h2>
            <p style="margin: 10px 0; color: #555;"><strong>Name:</strong> ${fullName}</p>
            <p style="margin: 10px 0; color: #555;"><strong>Email:</strong> <a href="mailto:${email}" style="color: #B8860B;">${email}</a></p>
            ${phone ? `<p style="margin: 10px 0; color: #555;"><strong>Phone:</strong> <a href="tel:${phone}" style="color: #B8860B;">${phone}</a></p>` : ''}
          </div>

          ${message ? `<div style="background: #f9f9f9; padding: 30px;">
            <h2 style="color: #333; font-size: 18px; margin-bottom: 20px;">Message</h2>
            <p style="color: #555; line-height: 1.6; white-space: pre-wrap;">${message}</p>
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
          <h1 style="color: #B8860B; font-weight: 300; font-size: 28px; margin-bottom: 30px;">Thank You, ${firstName}</h1>

          <p style="color: #555; line-height: 1.8; font-size: 16px;">
            ${isStyleBook && style
              ? `We've noted your interest in <strong>${style}</strong> and appreciate you reaching out to Beau Monde Builders.`
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
  } catch (error: any) {
    console.error("Error in send-contact-email function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
