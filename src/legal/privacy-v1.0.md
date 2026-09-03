# Crest Suite Privacy Policy

**Version 1.0 — Effective 3 September 2026 (18 Bhadra 2083 BS)**

This policy explains how **Bloom Hospitality Pvt. Ltd.** ("Crest", "we") collects, uses, stores and shares personal information in connection with the Crest Suite platform and website (the "Service"). It sits alongside our [Terms of Service](/legal/terms), which govern the Service itself. This policy is written to meet the Individual Privacy Act, 2075 (2018), the Individual Privacy Regulation, 2077 (2020), the Electronic Transactions Act, 2063 and the E-Commerce Act, 2081, and Article 28 of the Constitution of Nepal.

## 1. Two roles: our data and your data

**Where Crest decides why and how data is used** (we are the "collector" in the sense of the Privacy Act): account and billing information about our customers and their users, website visitor data, support correspondence, and usage data about how the Service is used.

**Where our Customer decides** (the Customer is the collector; Crest processes on the Customer's instructions): the guest, employee, vendor, sales and financial records that a hospitality business enters into Crest Suite ("Customer Data"). If you are a guest, employee or vendor of a business that uses Crest Suite, that business is responsible for telling you how your information is used and for handling your requests; contact them first. We will assist them in responding to you.

## 2. Information we collect

**Account information** — business name, trading name, PAN/VAT number, address, owner and user names, email addresses, phone numbers, role, and 4–6 digit PIN.

PINs are not stored as typed. A staff PIN is converted into an account password using a keyed one-way function before it reaches the authentication system. Separately, and so that a platform-level key rotation or loss does not force every staff member in every restaurant to be re-issued a PIN by hand, the PIN itself is also held encrypted in a vault readable only by Crest platform administrators, with an audit record written each time one is revealed. This applies to POS and Self-Service PINs only. Passwords chosen by a person — an owner's or a manager's login password — are never recoverable by us, and are held one-way only.

**Billing information** — plan, invoices, payment status and transaction references from payment providers. We do not store card numbers or wallet credentials; the payment provider handles those.

**Usage and device information** — log records including IP address, browser and device type, pages and features used, timestamps, error reports and sync events. On devices you use offline, the Service stores working data locally on the device to allow offline use.

**Acceptance records** — when you accept these documents we record which version you accepted, its content hash, the date and time, the IP address the request came from and your browser's user agent string. This is the evidence that the contract exists and is kept as described in section 9.

**Signup attempts** — when someone submits the trial signup form we record the IP address and email address of the attempt, before the attempt succeeds or fails, in order to rate-limit abuse.

**Support and communications** — messages you send us, and records of calls or chats.

**Customer Data** (processed for the Customer) — may include: guest names, contact details and order history; employee names, contact details, citizenship or ID numbers, bank details, attendance, leave, salary, tax and Social Security Fund details; vendor names, contact and payment details; sales, stock and financial records.

We do not intentionally collect sensitive personal information as defined in section 27 of the Privacy Act (caste, religion, political affiliation, sexual orientation, health, biometric data) about our own customers or users. Customers must not enter such information into free-text fields unless they have a lawful basis.

## 3. Why we use information

| Purpose | Information | Basis |
|---|---|---|
| Create and operate your account, authenticate users, sync data | Account, usage | Performing our contract with you |
| Bill you and collect payment | Account, billing | Contract; legal obligation (tax) |
| Provide support and respond to requests | Account, support | Contract |
| Secure the Service, prevent fraud and abuse, investigate incidents | Usage, account, signup attempts | Legitimate operation of the Service; legal obligation |
| Evidence that you accepted these documents | Acceptance records | Legal obligation; performing our contract |
| Improve the Service, fix bugs, plan capacity | Usage (aggregated where possible) | Legitimate operation |
| Send service notices (outages, invoices, legal updates) | Account | Contract |
| Send product news and offers | Account | Your consent; you can opt out any time |
| Comply with law, court orders and lawful government requests | Any | Legal obligation |
| Process Customer Data | Customer Data | Customer's instructions under our [Terms of Service](/legal/terms) |

We do not sell personal information. We do not use Customer Data to advertise to your guests or staff.

## 4. Cookies and local storage

The Service uses strictly necessary cookies and browser storage for login sessions, security, your preferences and the offline cache of the progressive web app. **We do not use any third-party analytics, advertising or tracking service on our website or in the Service.** You can clear local storage in your browser; doing so on a device with unsynced offline data may lose that data.

## 5. Who we share information with

**Service providers (sub-processors).** We use third parties to run the Service. Each is bound by contract to protect the data and to use it only to provide their service to us.

| Provider | Purpose | Location of processing |
|---|---|---|
| Supabase | Database, authentication, file storage | ap-northeast-1 (Tokyo, Japan) |
| Vercel | Application hosting and delivery | Global edge network; origin in ap-northeast-1 (Tokyo, Japan) |
| Supabase (auth email) | Password-reset and account emails only | Provider's region |
| Have I Been Pwned (Cloudflare) | Checking a chosen password against known breach corpora at the moment it is set. Only an anonymised partial hash of the password is sent; the password itself never leaves our servers | Global |
| Bank transfer | Subscription payments | Nepal |

We do not currently use a third-party transactional email provider, a website analytics provider, or an online payment gateway for our own subscription fees. We will update this table when a sub-processor changes and will notify Customers by email or in-app notice at least 15 days before a new sub-processor begins handling Customer Data.

**Professional advisers and authorities.** We may share information with our accountants, lawyers and insurers, and with courts, regulators or law enforcement where required by Nepali law or a valid legal process. Where the request concerns Customer Data we will notify the Customer unless prohibited.

**Business transfer.** If Crest's business is sold or reorganised, information may be transferred to the successor, which will be bound by this policy.

## 6. Where data is stored and cross-border transfer

Crest Suite's database is currently hosted with Supabase in the ap-northeast-1 (Tokyo, Japan) region, outside Nepal, with content delivered through Vercel's global network. By using the Service, and by accepting our Terms, you consent to your account information and Customer Data being stored and processed in those locations, and you confirm that you have obtained any consent needed from individuals whose data you enter.

Where Nepali regulation requires particular records to be hosted in Nepal (for example IRD-approved electronic billing), the affected component will be hosted on infrastructure in Nepal and this policy will be updated.

## 7. Security

We use encryption in transit (TLS) and at rest, role-based access with per-tenant data isolation enforced in the database itself, hashed passwords, keyed one-way derivation of staff PINs, audit logs, regular backups and least-privilege access for Crest staff. Crest staff access Customer Data only to provide support you request, investigate incidents or maintain the Service, and such access is logged. No system is perfectly secure; you are responsible for the security of your devices, credentials and PINs.

## 8. Data breach

If we become aware of unauthorised access to personal information that is likely to cause harm, we will notify affected Customers by email within 72 hours of confirming the breach, describe what happened and what we are doing, and cooperate with the Customer's own notification duties.

## 9. How long we keep information

| Information | Retention |
|---|---|
| Account information | Life of the account, then up to 90 days |
| Customer Data | Life of the account, then up to 90 days (trial accounts that do not subscribe: 15 days after the trial ends) |
| Invoices and tax records | As required by the Income Tax Act, 2058 and VAT Act, 2052 (currently at least 6 years) |
| Server and security logs | Up to 12 months |
| Trial signup attempt records (IP and email) | Up to 12 months |
| Support correspondence | 3 years |
| Legal acceptance records (which version you accepted, when, from where) | 7 years after the account ends, as evidence of the contract |
| Backups | Overwritten on a rolling schedule of up to 35 days |

## 10. Your rights

Under the Individual Privacy Act, 2075 and this policy, individuals whose information we hold as collector may:

- ask what personal information we hold about them and obtain a copy;
- ask us to correct inaccurate or incomplete information;
- ask us to delete information we no longer need, or withdraw consent for uses based on consent;
- object to marketing at any time using the unsubscribe link or by emailing us.

To exercise these rights, email [privacy@crestsuite.com](mailto:privacy@crestsuite.com) or write to Aashish Shrestha, Privacy Officer, at Saraswatinagar-6, Kathmandu. We will respond within 15 days and may need to verify your identity. If you are unhappy with our response you may complain to the District Court under the Privacy Act; note that the Act sets a time limit for filing complaints (currently three months from the date you knew of the matter).

If your request concerns Customer Data held on behalf of a business that uses Crest Suite, we will forward it to that business and help them respond.

## 11. Children

The Service is for businesses and is not directed at anyone under 18. Customers must not create user accounts for anyone under the legal working age under the Labour Act, 2074 and Child Labour (Prohibition and Regulation) Act, 2056.

## 12. Changes to this policy

Each version of this policy has a version number, effective date and content hash published at [crestsuite.com/legal/privacy](/legal/privacy). We will notify Customers of material changes at least 30 days in advance by email or in-app notice, and where the change materially affects Customer Data we will ask for acceptance of the new version.

## 13. Contact

Privacy requests and questions: [privacy@crestsuite.com](mailto:privacy@crestsuite.com)

Privacy officer: Aashish Shrestha

Bloom Hospitality Pvt. Ltd., Saraswatinagar-6, Kathmandu
