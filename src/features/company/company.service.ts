import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/features/prisma/prisma.service';
import { CompanyDto } from './dtos/company.dto';
import { Company } from './interfaces/company.interface';

@Injectable()
export class CompanyService {
  constructor(private prisma: PrismaService) {}

  async createCompany(company: CompanyDto): Promise<Company> {
    return this.prisma.company.create({
      data: company,
    });
  }

  async getCompany(id: number): Promise<Company> {
    return this.prisma.company.findUnique({
      where: {
        id: id,
      },
    });
  }
}
