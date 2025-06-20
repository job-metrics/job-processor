import dotenv from 'dotenv';
import sequelize from '../config/database';
import { PromptsGenerator } from "./PromptsGenerator";
import JobOffer from '../models/JobOffer';
import Benefit from '../models/Benefit';
import Requirement from '../models/Requirement';
import Keyword from '../models/Keyword';
import ContractType from '../models/ContractType';
import Profession from '../models/Profession';
import Industry from '../models/Industry';
import Salary from '../models/Salary';
import Company from '../models/Company';
import Location from '../models/Location';
import WorkMode from '../models/WorkMode';
import '../models/associations';
import {JobOfferLlmResponse} from "../models/JobOfferLlmResponse";
import { MessageStreamReader } from "./MessageStreamReader";

dotenv.config();


export class MessageProcessor {
    
    private readonly llmUrl: string;
    private readonly llmVersion: string;
    private messageStreamReader: MessageStreamReader;

    constructor() {
        if (!process.env.AWS_REGION) {
            throw new Error("AWS_REGION environment variable is not set.");
        }
        if (!process.env.AWS_BUCKET_NAME) {
            throw new Error("AWS_S3_ARCHIVE_BUCKET environment variable is not set.");
        }
        if(!process.env.LLM_VERSION){
            throw new Error("LLM_VERSION environment variable is not set.");
        }
        this.llmVersion = process.env.LLM_VERSION;
        if (!process.env.LLM_URL) {
            throw new Error("LLM_URL environment variable is not set.");
        }
        this.llmUrl = process.env.LLM_URL;
        this.messageStreamReader = new MessageStreamReader(this.llmUrl, this.llmVersion);
    }

    async processMessage(message: string): Promise<void> {
        
        const promptsGenerator = new PromptsGenerator();
        const prompt = promptsGenerator.generateJobOfferPrompt(message);

        const responses = await this.messageStreamReader.readResponsesFromPrompt(prompt);
        const response_body = responses.join('');
        if (!response_body) {
            throw Error('Returned no text from LLM Api');
        }

        const transaction = await sequelize.transaction();
        try {
            // Parse the LLM response string into our LlmJobOffer structure
            const record: JobOfferLlmResponse = JSON.parse(response_body).json //tesing quirk;

            // --- Validate essential data ---
            if (!record || !record.external_id ) {
                throw new Error('Invalid record format: externalId is missing');
            }
            if (!record.title) {
                throw new Error('Invalid record format: title is missing.');
            }
             if (!record.source_url) {
                throw new Error('Invalid record format: source_url is missing.');
            }

            // 1. Location (Job Location)
            let jobLocationInstance: Location | null = null;
            if (record.location) {
                const [location] = await Location.findOrCreate({
                    where: { city: record.location.city, country: record.location.country ?? null }, // Use city/country as key
                    defaults: { ...record.location },
                    transaction
                });
                jobLocationInstance = location;
            }

            // 2. Company Location (if company exists and has location)
            let companyLocationInstance: Location | null = null;
            if (record.company?.location) {
                const [location] = await Location.findOrCreate({
                    where: { city: record.company.location.city, country: record.company.location.country ?? null },
                    defaults: { ...record.company.location },
                    transaction
                });
                companyLocationInstance = location;
            }

            // 3. Company
            let companyInstance: Company | null = null;
            if (record.company) {
                const [company] = await Company.findOrCreate({
                    where: { name: record.company.name }, // Use name as key
                    defaults: {
                        ...record.company,
                        location_id: companyLocationInstance?.location_id // Link to the found/created company location
                    },
                    transaction
                });
                // If company was found, update its location if provided and different
                if (!company.isNewRecord && companyLocationInstance && company.location_id !== companyLocationInstance.location_id) {
                    company.location_id = companyLocationInstance.location_id;
                    await company.save({ transaction });
                }
                companyInstance = company;
            }

            // 4. Salary
            let salaryInstance: Salary | null = null;
            if (record.salary) {
                 // findOrCreate might create many similar salary entries.
                 // Consider if upsert based on ID (if LLM provides reliable ones) or just create is better.
                 // Sticking to findOrCreate based on attributes for now.
                const [salary] = await Salary.findOrCreate({
                    where: { 
                        min_value: record.salary.min_value ?? null,
                        max_value: record.salary.max_value ?? null,
                        currency: record.salary.currency ?? null,
                        period: record.salary.period ?? null,
                    },
                    defaults: { ...record.salary },
                    transaction
                });
                salaryInstance = salary;
            }

            // 5. Industry
            let industryInstance: Industry | null = null;
            if (record.industry) {
                const [industry] = await Industry.findOrCreate({
                    where: { name: record.industry },
                    defaults: { name: record.industry },
                    transaction
                });
                industryInstance = industry;
            }

            // 6. Profession
            let professionInstance: Profession | null = null;
            if (record.profession) {
                const [profession] = await Profession.findOrCreate({
                    where: { name: record.profession },
                    defaults: { name: record.profession },
                    transaction
                });
                professionInstance = profession;
            }

            // --- Upsert JobOffer --- 
            const jobOfferData = {
                ...record,
                // Assign foreign keys from found/created instances
                company_id: companyInstance?.company_id,
                salary_id: salaryInstance?.salary_id,
                location_id: jobLocationInstance?.location_id,
                industry_id: industryInstance?.industry_id,
                profession_id: professionInstance?.profession_id,
                // Remove nested objects that are not direct columns
                company: undefined,
                salary: undefined,
                location: undefined,
                industry: undefined,
                profession: undefined,
                benefits: undefined,
                requirements: undefined,
                workModes: undefined,
                contractTypes: undefined,
                keywords: undefined
            };

            // Use upsert based on externalId to avoid duplicates
            const [jobOfferInstance] = await JobOffer.upsert(jobOfferData, {
                transaction,
                returning: true, // Needed to get the instance back
                conflictFields: ['external_id'] // Specify the unique key for conflict detection
            });
            
            if (!jobOfferInstance) {
                throw new Error("Failed to upsert JobOffer record.");
            }

            console.log(`Upserted Job Offer ID: ${jobOfferInstance.job_offer_id}, External ID: ${jobOfferInstance.external_id}`);

            // --- Process Many-to-Many relationships ---

            // 7. Benefits
            if (record.benefits && record.benefits.length > 0) {
                const benefitInstances = await Promise.all(record.benefits.map(async (benefitData) => {
                    const [benefit] = await Benefit.findOrCreate({
                        where: { name: benefitData },
                        defaults: { name: benefitData },
                        transaction
                    });
                    return benefit;
                }));
                await (jobOfferInstance as any).setBenefits(benefitInstances, { transaction });
            }

            // 8. Requirements
            if (record.requirements && record.requirements.length > 0) {
                const requirementInstances = await Promise.all(record.requirements.map(async (reqData) => {
                    const [requirement] = await Requirement.findOrCreate({
                        where: { name: reqData },
                        defaults: { name: reqData },
                        transaction
                    });
                    return requirement;
                }));
                await (jobOfferInstance as any).setRequirements(requirementInstances, { transaction });
            }

            // 9. WorkModes
            if (record.workModes && record.workModes.length > 0) {
                const workModeInstances = await Promise.all(record.workModes.map(async (wmData) => {
                    const [workMode] = await WorkMode.findOrCreate({
                        where: { name: wmData },
                        defaults: { name: wmData },
                        transaction
                    });
                    return workMode;
                }));
                await (jobOfferInstance as any).setWorkModes(workModeInstances, { transaction });
            }

            if (record.contractTypes && record.contractTypes.length > 0) {
                const contractTypeInstances = await Promise.all(record.contractTypes.map(async (ctData) => {
                    const [contractType] = await ContractType.findOrCreate({
                        where: { name: ctData },
                        defaults: { name: ctData },
                        transaction
                    });
                    return contractType;
                }));
                await (jobOfferInstance as any).setContractTypes(contractTypeInstances, { transaction });
            }

            if (record.keywords && record.keywords.length > 0) {
                const keywordInstances = await Promise.all(record.keywords.map(async (kwData) => {
                    const [keyword] = await Keyword.findOrCreate({
                        where: { name: kwData },
                        defaults: { name: kwData },
                        transaction
                    });
                    return keyword;
                }));
                await (jobOfferInstance as any).setKeywords(keywordInstances, { transaction });
            }

            await transaction.commit();
            console.log(`Successfully processed and saved Job Offer with externalId: ${record.external_id}`);

        } catch (error: any) {
            console.error('Error processing message or saving to database:', error);
            await transaction.rollback();
            throw error;
        }
    }
}

